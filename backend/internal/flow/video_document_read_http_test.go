package flow

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	"github.com/gin-gonic/gin"
	"yingce/backend/internal/model"
)

func TestDocumentReadHTTPBoundedScopedForwarding(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := testDB(t)
	scope, err := ResolveScope(db, "u_alice", "")
	if err != nil {
		t.Fatal(err)
	}
	want := `{"document_id":"doc_fixture","revision":3,"offset":19999,"max_chars":19999}`
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, err := Verify(key, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), "loom-engine", time.Now())
		body, readErr := io.ReadAll(r.Body)
		if err != nil || readErr != nil || claims.TenantID != scope.TenantID || claims.WorkspaceID != scope.WorkspaceID || claims.Actor.ID != "u_alice" || !claims.HasScope("intel.documents.read") || r.Method != "POST" || r.URL.RequestURI() != "/v1/documents/read" || r.Header.Get("X-Idempotency-Key") != "" || string(body) != want {
			t.Error("document read lost its server-resolved scope or exact read parameters")
			w.WriteHeader(400)
			return
		}
		calls++
		_, _ = io.WriteString(w, `{"code":0,"data":{"offset":19999,"text":"fixture"},"msg":"ok"}`)
	}))
	defer upstream.Close()
	user := "u_alice"
	router := gin.New()
	RegisterRoutes(router.Group("/api"), db, Config{EngineURL: upstream.URL, SigningKey: key, Issuer: "flow-platform", Audience: "loom-engine", TTL: MaxTokenTTL}, func(*gin.Context) (*model.User, error) {
		if user == "" {
			return nil, nil
		}
		return &model.User{ID: user}, nil
	})
	request := func(body, workspace string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/api/intelligence/documents/read", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Workspace-Id", workspace)
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		return res
	}
	if res := request(want, scope.WorkspaceID); res.Code != 200 || calls != 1 {
		t.Fatalf("scoped read route not forwarded: %d, calls=%d", res.Code, calls)
	}
	for _, tc := range []struct {
		body, reason string
		status       int
	}{
		{`null`, "invalid_json", 400}, {`[]`, "invalid_json", 400}, {`{`, "invalid_json", 400},
		{want + strings.Repeat(" ", 1<<20), "request_too_large", 413},
	} {
		res := request(tc.body, scope.WorkspaceID)
		if res.Code != tc.status || !strings.Contains(res.Body.String(), `"reason":"`+tc.reason+`"`) || calls != 1 {
			t.Fatalf("invalid input crossed read boundary: %d, calls=%d", res.Code, calls)
		}
	}
	for _, field := range []string{"tenant", "tenant_id", "workspace", "workspace_id", "actor", "grant", "scopes", "_meta", "callback", "endpoint", "cookie", "api_key", "unexpected"} {
		res := request(fmt.Sprintf(`{"document_id":"doc_fixture",%q:"untrusted"}`, field), scope.WorkspaceID)
		if res.Code != 400 || !strings.Contains(res.Body.String(), `"reason":"untrusted_authority_field"`) || calls != 1 {
			t.Fatalf("untrusted %s crossed read boundary: %d", field, res.Code)
		}
	}
	user = ""
	if res := request(want, scope.WorkspaceID); res.Code != 401 || calls != 1 {
		t.Fatal("unauthenticated document read reached engine")
	}
	user = "u_bob"
	if res := request(want, scope.WorkspaceID); res.Code != 404 || calls != 1 {
		t.Fatal("foreign workspace selector reached engine")
	}
	// The wrapper caps the entire proxy call, not just HTTP client dial time.
	bounded := gin.New()
	bounded.POST("/read", documentReadBoundary(func(c *gin.Context) {
		deadline, ok := c.Request.Context().Deadline()
		if !ok || time.Until(deadline) > 10*time.Second || time.Until(deadline) < 9*time.Second {
			t.Error("document read did not receive the short-call deadline")
		}
		c.Status(204)
	}))
	res := httptest.NewRecorder()
	bounded.ServeHTTP(res, httptest.NewRequest("POST", "/read", strings.NewReader(want)))
	if res.Code != 204 {
		t.Fatal("bounded read did not reach delegate")
	}
}

// Actual Go REST -> signed EngineClient -> Loom HTTP -> indexed revision.
// Only acquisition is synthetic. Authentication is the host's UserFunc seam;
// the disposable fullstack test separately exercises real password sessions.
func TestVideoQADocumentReadHTTPAndRevocation(t *testing.T) {
	if os.Getenv("FLOW_VIDEO_CROSSLAYER_TEST") != "1" {
		t.Skip("set FLOW_VIDEO_CROSSLAYER_TEST=1 with Loom dependencies installed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	node := os.Getenv("VIDEO_QA_NODE")
	if node == "" {
		node = "node"
	}
	cmd := exec.CommandContext(ctx, node, "--experimental-strip-types", "validation/video-knowledge/gateway-paging-loom-harness.ts")
	cmd.Dir = filepath.Join("..", "..", "..", "services", "loom-engine")
	cmd.Env = append(os.Environ(), "VIDEO_QA_SIGNING_KEY="+string(key), "FLOW_VIDEO_ENABLED=true")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Signal(os.Interrupt); _ = cmd.Wait() })
	lines := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		if scanner.Scan() {
			lines <- scanner.Text()
		} else {
			lines <- ""
		}
	}()
	var endpoint string
	select {
	case endpoint = <-lines:
	case <-ctx.Done():
		t.Fatal("Loom startup deadline exceeded")
	}
	if !strings.HasPrefix(endpoint, "http://127.0.0.1:") {
		t.Fatal("Loom did not report fixture endpoint")
	}
	db := testDB(t)
	scope, err := ResolveScope(db, "u_alice", "")
	if err != nil {
		t.Fatal(err)
	}
	cfg := Config{EngineURL: endpoint, SigningKey: key, Issuer: "flow-platform", Audience: "loom-engine", TTL: MaxTokenTTL}
	engine := EngineClient{Cfg: cfg}
	call := func(method, path, idem string, body any) map[string]any {
		t.Helper()
		raw, _ := json.Marshal(body)
		status, out, err := engine.Do(ctx, scope, Actor{Type: "user", ID: "u_alice"}, method, path, idem, raw)
		if err != nil || status >= 400 {
			t.Fatalf("fixture engine %s %s failed: status=%d error=%v", method, path, status, err)
		}
		var envelope struct {
			Data map[string]any `json:"data"`
		}
		if err := json.Unmarshal(out, &envelope); err != nil {
			t.Fatal(err)
		}
		return envelope.Data
	}
	profile := call("POST", "/v1/video/profiles", "http-read-profile", map[string]any{"name": "Synthetic HTTP paging", "config": map[string]any{"required_capabilities": []string{"transcript"}}})
	source := call("POST", "/v1/sources", "http-read-source", map[string]any{"kind": "bilibili", "title": "Synthetic HTTP paging", "url": "https://www.bilibili.com/video/BV1QA0000001?p=1", "config": map[string]any{"source_type": "video", "native_id": "BV1QA0000001", "part_id": "1", "profile_id": profile["id"], "profile_version": profile["version"], "usage_basis": "Self-authored synthetic fixture; no platform acquisition", "allowed_uses": []string{"knowledge"}}})
	job := call("POST", "/v1/video/jobs", "http-read-job", map[string]any{"source_id": source["id"], "native_id": "BV1QA0000001", "part_id": "1"})
	var ready map[string]any
	for {
		ready = call("GET", "/v1/video/jobs/"+job["video_job_id"].(string), "", nil)
		if ready["completion_level"] == "knowledge_ready" {
			break
		}
		if ready["state"] == "failed" || ready["state"] == "reconciliation_required" || ctx.Err() != nil {
			t.Fatal("fixture background processing did not become knowledge_ready")
		}
		time.Sleep(50 * time.Millisecond)
	}
	user := "u_alice"
	router := gin.New()
	RegisterRoutes(router.Group("/api"), db, cfg, func(*gin.Context) (*model.User, error) {
		if user == "" {
			return nil, nil
		}
		return &model.User{ID: user}, nil
	})
	read := func(workspace string, params map[string]any, expected int) map[string]any {
		t.Helper()
		body, _ := json.Marshal(params)
		req := httptest.NewRequest("POST", "/api/intelligence/documents/read", strings.NewReader(string(body)))
		req.Header.Set("X-Workspace-Id", workspace)
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		if res.Code != expected {
			t.Fatalf("real document read status=%d want=%d", res.Code, expected)
		}
		var envelope struct {
			Code int            `json:"code"`
			Data map[string]any `json:"data"`
		}
		if err := json.Unmarshal(res.Body.Bytes(), &envelope); err != nil {
			t.Fatal(err)
		}
		if (expected == 200 && envelope.Code != 0) || (expected != 200 && envelope.Code != expected) {
			t.Fatal("document read HTTP and business status disagree")
		}
		return envelope.Data
	}
	params := map[string]any{"document_id": ready["document_id"], "revision": ready["revision"], "offset": 0, "max_chars": 997}
	var document strings.Builder
	offset, pages := 0, 0
	for {
		params["offset"] = offset
		page := read(scope.WorkspaceID, params, 200)
		part := page["text"].(string)
		document.WriteString(part)
		units := len(utf16.Encode([]rune(part)))
		if units == 0 || units > 997 || page["offset"] != float64(offset) {
			t.Fatal("document page was empty, unbounded or misaligned")
		}
		offset += units
		pages++
		coverage := page["coverage"].(map[string]any)
		if coverage["returned_chars"] != float64(units) {
			t.Fatal("document page length was not UTF16")
		}
		if coverage["next_offset"] == nil {
			if coverage["total_chars"] != float64(offset) || coverage["truncated"] != false {
				t.Fatal("document coverage lost tail")
			}
			break
		}
		if coverage["next_offset"] != float64(offset) || pages > 100 {
			t.Fatal("document cursor failed to progress")
		}
	}
	var segments []string
	for i := 0; i < 81; i++ {
		repeats := 50
		if i == 40 {
			repeats = 420
		}
		segments = append(segments, fmt.Sprintf("segment-%03d:", i)+strings.Repeat("\u4e2d\u6587\U0001f9ea", repeats)+fmt.Sprintf(":tail-%d", i))
	}
	if document.String() != "Synthetic HTTP paging\n\n"+strings.Join(segments, "\n") || pages < 10 {
		t.Fatal("REST paging lost exact indexed Unicode text")
	}
	params["offset"] = 0.5
	read(scope.WorkspaceID, params, 400)
	emojiByte := strings.Index(document.String(), "\U0001f9ea")
	params["offset"] = len(utf16.Encode([]rune(document.String()[:emojiByte]))) + 1
	read(scope.WorkspaceID, params, 400)
	params["offset"] = 0
	params["revision"] = 1000000
	read(scope.WorkspaceID, params, 404)
	params["revision"] = ready["revision"]
	user = ""
	read(scope.WorkspaceID, params, 401)
	user = "u_bob"
	read(scope.WorkspaceID, params, 404)
	bob, err := ResolveScope(db, user, "")
	if err != nil {
		t.Fatal(err)
	}
	read(bob.WorkspaceID, params, 404)
	user = "u_alice"
	other := model.Workspace{ID: "ws_document_read_other", TenantID: scope.TenantID, Slug: "document-read-other", Name: "Other fixture workspace"}
	if err := db.Create(&other).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.WorkspaceMembership{ID: "wm_document_read_other", WorkspaceID: other.ID, UserID: user, Role: "viewer"}).Error; err != nil {
		t.Fatal(err)
	}
	read(other.ID, params, 404)
	if err := db.Model(&model.WorkspaceMembership{}).Where("workspace_id=? AND user_id=?", scope.WorkspaceID, user).Update("role", "viewer").Error; err != nil {
		t.Fatal(err)
	}
	read(scope.WorkspaceID, params, 200)
	if err := db.Model(&model.Membership{}).Where("tenant_id=? AND user_id=?", scope.TenantID, user).Update("status", "revoked").Error; err != nil {
		t.Fatal(err)
	}
	read(scope.WorkspaceID, params, 404)
	if err := db.Model(&model.Membership{}).Where("tenant_id=? AND user_id=?", scope.TenantID, user).Update("status", "active").Error; err != nil {
		t.Fatal(err)
	}
	// A validly signed token without document-read scope is denied by real Loom.
	token, err := Sign(key, ExecutionContext{Issuer: cfg.Issuer, Audience: cfg.Audience, TenantID: scope.TenantID, WorkspaceID: scope.WorkspaceID, Actor: Actor{Type: "user", ID: user}, Scopes: []string{"intel.video.read"}, PolicyVersion: "policy_v1"}, time.Now(), MaxTokenTTL)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(params)
	req, _ := http.NewRequestWithContext(ctx, "POST", endpoint+"/v1/documents/read", strings.NewReader(string(raw)))
	req.Header.Set("Authorization", "Bearer "+token)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatalf("Loom accepted missing document-read scope: %d", response.StatusCode)
	}
	call("POST", "/v1/sources/"+source["id"].(string)+"/revoke", "http-read-revoke", map[string]any{"reason": "Synthetic fixture authorization withdrawn"})
	read(scope.WorkspaceID, params, 404)
	t.Logf("real scoped REST recovered %d UTF16 units in %d pages; cross-tenant/workspace, revoked membership/source and missing permission denied", offset, pages)
}
