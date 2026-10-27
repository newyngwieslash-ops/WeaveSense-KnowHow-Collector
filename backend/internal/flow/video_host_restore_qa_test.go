package flow

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"yingce/backend/internal/model"
)

// Restore ONLY the host SQLite snapshot while the independently retained real
// Loom database/journal already knows a later erase. No mocked tombstone feed.
func TestVideoQAHostOnlySQLiteRestoreReconcilesAuthoritativeTombstones(t *testing.T) {
	runVideoQAHostOnlySQLiteRestore(t, "erased")
}

func TestVideoQAHostOnlySQLiteRestoreReconcilesAuthoritativeRevocation(t *testing.T) {
	runVideoQAHostOnlySQLiteRestore(t, "revoked")
}

func TestVideoQASourceAuthorizationExpiryFencesRestoredHostCaches(t *testing.T) {
	runVideoQAHostOnlySQLiteRestore(t, "expired")
}

func TestVideoQATypedRetentionExpiryFencesRestoredHostCaches(t *testing.T) {
	runVideoQAHostOnlySQLiteRestore(t, "ttl")
}

func runVideoQAHostOnlySQLiteRestore(t *testing.T, action string) {
	if os.Getenv("FLOW_VIDEO_CROSSLAYER_TEST") != "1" {
		t.Skip("requires locked Loom dependencies and explicit cross-layer opt-in")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	db := testDB(t)
	scope, err := ResolveScope(db, "u_alice", "")
	if err != nil {
		t.Fatal(err)
	}
	scopeJSON, _ := json.Marshal(map[string]string{"tenant_id": scope.TenantID, "workspace_id": scope.WorkspaceID})
	cmd := exec.CommandContext(ctx, "node", "--experimental-strip-types", "validation/video-knowledge/host-restore-loom-harness.ts")
	cmd.Dir = filepath.Join("..", "..", "..", "services", "loom-engine")
	cmd.Env = append(os.Environ(), "VIDEO_QA_SIGNING_KEY="+string(key), "VIDEO_QA_SCOPE="+string(scopeJSON))
	if action == "expired" {
		cmd.Env = append(cmd.Env, "VIDEO_QA_AUTH_EXPIRES_SECONDS=6")
	}
	if action == "ttl" {
		cmd.Env = append(cmd.Env, "VIDEO_QA_TYPED_TTL=1")
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Signal(os.Interrupt); _ = cmd.Wait() })
	line := make(chan []byte, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 4096), 1<<20)
		if scanner.Scan() {
			line <- append([]byte(nil), scanner.Bytes()...)
		} else {
			line <- nil
		}
	}()
	var fixture struct {
		Endpoint               string    `json:"endpoint"`
		AuthorizationExpiresAt time.Time `json:"authorization_expires_at"`
		Retention              struct {
			ExpiresAt  time.Time `json:"text_access_expires_at"`
			PolicyHash string    `json:"retention_policy_hash"`
		} `json:"retention"`
		Job struct {
			ID         string `json:"video_job_id"`
			AssetID    string `json:"asset_id"`
			DocumentID string `json:"document_id"`
			Revision   int    `json:"revision"`
		} `json:"job"`
		VideoReport struct {
			ID string `json:"report_id"`
		} `json:"video_report"`
		RSSReport struct {
			ID string `json:"report_id"`
		} `json:"rss_report"`
		RSSDocument struct {
			ID string `json:"id"`
		} `json:"rss_document"`
		Events []Event `json:"events"`
	}
	select {
	case raw := <-line:
		if err := json.Unmarshal(raw, &fixture); err != nil {
			t.Fatalf("Loom fixture: %v, %s", err, raw)
		}
	case <-ctx.Done():
		t.Fatal("Loom startup deadline")
	}
	if !strings.HasPrefix(fixture.Endpoint, "http://127.0.0.1:") {
		t.Fatal("invalid loopback fixture endpoint")
	}
	target, _ := url.Parse(fixture.Endpoint)
	proxy := httputil.NewSingleHostReverseProxy(target)
	var unavailable atomic.Bool
	fault := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if unavailable.Load() && strings.Contains(r.URL.Path, "retention") {
			http.Error(w, "synthetic authoritative feed outage", 503)
			return
		}
		proxy.ServeHTTP(w, r)
	}))
	t.Cleanup(fault.Close)
	cfg := Config{EngineURL: fault.URL, SigningKey: key, Issuer: "flow-platform", Audience: "loom-engine", TTL: MaxTokenTTL}
	t.Setenv("LOOM_ENGINE_URL", cfg.EngineURL)
	t.Setenv("FLOW_INTERNAL_JWT_SIGNING_KEY", string(cfg.SigningKey))
	t.Setenv("FLOW_INTERNAL_JWT_ISSUER", cfg.Issuer)
	t.Setenv("FLOW_INTERNAL_JWT_AUDIENCE", cfg.Audience)
	client := EngineClient{Cfg: cfg}
	newHost := func(database *gorm.DB) *httptest.Server {
		router := gin.New()
		api := router.Group("/api")
		user := func(*gin.Context) (*model.User, error) { return &model.User{ID: "u_alice", Username: "u_alice"}, nil }
		RegisterRoutes(api, database, cfg, user)
		server := httptest.NewServer(router)
		t.Cleanup(server.Close)
		return server
	}
	host := newHost(db)
	request := func(server *httptest.Server, path string) (int, string) {
		t.Helper()
		req, _ := http.NewRequestWithContext(ctx, "GET", server.URL+path, nil)
		req.Header.Set("X-Workspace-Id", scope.WorkspaceID)
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		raw, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, string(raw)
	}
	for _, event := range fixture.Events {
		if event.OccurredAt.IsZero() {
			event.OccurredAt = time.Now().UTC()
		}
		if _, err := ConsumeEvent(db, "platform-projection", event); err != nil {
			t.Fatal(err)
		}
	}
	ss, err := ResolveSubject(db, "u_alice", AgentSubject{Kind: SubjectWorkspace, ID: scope.WorkspaceID})
	if err != nil {
		t.Fatal(err)
	}
	conversations := Conversations{DB: db}
	conversation, err := conversations.Create("u_alice", ss, "User-authored restoration question")
	if err != nil {
		t.Fatal(err)
	}
	tools := Tools{DB: db, Engine: client}
	result, err := tools.Invoke(ctx, conversation, ss, "u_alice", "qa-read-before-backup", "intel_read_document", map[string]any{"document_id": fixture.Job.DocumentID, "revision": float64(fixture.Job.Revision)}, "")
	if err != nil || result.Status != "succeeded" {
		t.Fatalf("real read before backup: %+v %v", result, err)
	}
	rawResult, _ := json.Marshal(result)
	if !strings.Contains(string(rawResult), "PRIVATE_HOST_RESTORE_CANARY") {
		t.Fatal("real tool response lacks negative-control canary")
	}
	for _, message := range []model.FlowAgentMessage{
		{Role: "user", Content: "Keep this user-authored question"},
		{Role: "tool", ToolCallID: result.CallID, ToolName: result.Tool, Content: string(rawResult)},
		{Role: "assistant", Content: "PRIVATE_HOST_RESTORE_CANARY derived answer"},
	} {
		if _, err := conversations.Append(conversation, message); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Model(&conversation).Updates(map[string]any{"summary": "PRIVATE_HOST_RESTORE_CANARY summary", "confirmed_plans": `[{"text":"PRIVATE_HOST_RESTORE_CANARY"}]`}).Error; err != nil {
		t.Fatal(err)
	}
	native := seedVideoQANativeRestoreCaches(t, db, conversation)
	modelContext, _ := json.Marshal(videoModelContext{WorkspaceID: scope.WorkspaceID, JobID: fixture.Job.ID, InputHash: "qa-preserved-audit-hash"})
	if err := db.Create(&model.FlowModelTask{ID: "qa-restored-model-cache", TenantID: scope.TenantID, IdemKey: "qa-restored-model-cache", Purpose: "video_summary", Status: "succeeded", Request: `{"user":"PRIVATE_HOST_RESTORE_CANARY"}`, Result: `{"summary":"PRIVATE_HOST_RESTORE_CANARY"}`, Context: string(modelContext), CostMicro: 42}).Error; err != nil {
		t.Fatal(err)
	}
	status, notices := request(host, "/api/intelligence/notifications")
	if status != 200 || !strings.Contains(notices, "PRIVATE_HOST_RESTORE_CANARY") || !strings.Contains(notices, "PUBLIC_RSS_CANARY") {
		t.Fatalf("before-backup notifications %d %s", status, notices)
	}
	backup := filepath.Join(t.TempDir(), "host-before-erasure.sqlite")
	if err := db.Exec("VACUUM INTO ?", backup).Error; err != nil {
		t.Fatal(err)
	}
	erase, _ := json.Marshal(map[string]any{"action": action, "asset_id": fixture.Job.AssetID, "reason": "Synthetic host-only restore regression"})
	var output []byte
	if action == "expired" || action == "ttl" {
		expiresAt := fixture.AuthorizationExpiresAt
		if action == "ttl" {
			expiresAt = fixture.Retention.ExpiresAt
			if len(fixture.Retention.PolicyHash) != 64 {
				t.Fatal("typed retention policy not frozen")
			}
		}
		if expiresAt.IsZero() || !expiresAt.After(time.Now()) {
			t.Fatal("expiry fixture was not initially authorized")
		}
		// The public read must observe natural source-grant expiry without an
		// explicit user revoke command or a manually delivered tombstone.
		time.Sleep(time.Until(expiresAt) + 100*time.Millisecond)
	} else {
		status, output, err = client.Do(ctx, scope, Actor{Type: "user", ID: "u_alice"}, "POST", "/v1/video/retention", "qa-erase-after-host-backup", erase)
		if err != nil || status >= 400 {
			t.Fatalf("real Loom erase: %d %v %s", status, err, output)
		}
	}
	status, notices = request(host, "/api/intelligence/notifications")
	if (action == "erased" && status != 200) || strings.Contains(notices, "PRIVATE_HOST_RESTORE_CANARY") {
		t.Fatalf("current host did not reconcile authoritative erase: %d %s", status, notices)
	}
	oldBytes, err := os.ReadFile(backup)
	if err != nil {
		t.Fatal(err)
	}
	restoredPath := filepath.Join(t.TempDir(), "restored-host.sqlite")
	if err := os.WriteFile(restoredPath, oldBytes, 0600); err != nil {
		t.Fatal(err)
	}
	restored, err := gorm.Open(sqlite.Open(restoredPath), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := restored.DB()
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	var oldCall model.FlowAgentToolCall
	if err := restored.Where("conversation_id = ?", conversation.ID).First(&oldCall).Error; err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(oldCall.Result, "PRIVATE_HOST_RESTORE_CANARY") {
		t.Fatal("backup was not truly before erasure")
	}
	var tombstones int64
	restored.Model(&model.FlowEventInbox{}).Where("type = ?", "knowledge.dependencies_revoked").Count(&tombstones)
	if tombstones != 0 {
		t.Fatal("old host snapshot already contained later tombstone")
	}
	native.assertOldBackup(t, restored)
	clone := newHost(restored)
	unavailable.Store(true)
	status, notices = request(clone, "/api/intelligence/notifications")
	if status != 503 || strings.Contains(notices, "PRIVATE_HOST_RESTORE_CANARY") {
		t.Fatalf("unknown authoritative watermark exposed notification: %d %s", status, notices)
	}
	status, history := request(clone, "/api/agent/conversations/"+conversation.ID+"/messages")
	if status < 400 || strings.Contains(history, "PRIVATE_HOST_RESTORE_CANARY") {
		t.Fatalf("unknown watermark exposed old history: %d %s", status, history)
	}
	native.assertBlocked(t, restored)
	status, rss := request(clone, "/api/intelligence/reports/"+fixture.RSSReport.ID)
	if status != 200 || !strings.Contains(rss, "PUBLIC_RSS_CANARY") {
		t.Fatalf("unrelated authoritative RSS path unavailable: %d %s", status, rss)
	}
	unavailable.Store(false)
	status, notices = request(clone, "/api/intelligence/notifications")
	if (action == "erased" && (status != 200 || !strings.Contains(notices, "PUBLIC_RSS_CANARY"))) || strings.Contains(notices, "PRIVATE_HOST_RESTORE_CANARY") {
		t.Fatalf("restored projection not repaired: %d %s", status, notices)
	}
	if action != "erased" {
		status, history = request(clone, "/api/agent/conversations/"+conversation.ID+"/messages")
		if status < 400 || strings.Contains(history, "PRIVATE_HOST_RESTORE_CANARY") {
			t.Fatalf("revoked derived history visible after tool-cache scrub: %d %s", status, history)
		}
		native.assertBlocked(t, restored)
		// Revocation is an access fence, not a physical erasure receipt. A later
		// erase must still find exact linkage after tool arguments were scrubbed.
		erase, _ = json.Marshal(map[string]any{"action": "erased", "asset_id": fixture.Job.AssetID, "reason": "Synthetic revoke-then-erase regression"})
		status, output, err = client.Do(ctx, scope, Actor{Type: "user", ID: "u_alice"}, "POST", "/v1/video/retention", "qa-erase-after-revoke", erase)
		if err != nil || status >= 400 {
			t.Fatalf("erase after revoke: %d %v %s", status, err, output)
		}
		status, notices = request(clone, "/api/intelligence/notifications")
		if status != 200 || strings.Contains(notices, "PRIVATE_HOST_RESTORE_CANARY") {
			t.Fatalf("erase after revoked snapshot: %d %s", status, notices)
		}
	}
	status, history = request(clone, "/api/agent/conversations/"+conversation.ID+"/messages")
	if status != 200 || strings.Contains(history, "PRIVATE_HOST_RESTORE_CANARY") || !strings.Contains(history, "Keep this user-authored question") {
		t.Fatalf("history erase/owner boundary: %d %s", status, history)
	}
	var cache model.FlowModelTask
	restored.First(&cache, "id = ?", "qa-restored-model-cache")
	if cache.Request != "" || cache.Result != "" || cache.CostMicro != 42 {
		t.Fatalf("restored model payload/audit boundary: %+v", cache)
	}
	var repaired model.FlowAgentConversation
	restored.First(&repaired, "id = ?", conversation.ID)
	if strings.Contains(repaired.Summary+repaired.ConfirmedPlans, "PRIVATE_HOST_RESTORE_CANARY") {
		t.Fatal("conversation summary/plans resurrected")
	}
	native.assertErased(t, restored)
	status, notices = request(clone, "/api/intelligence/notifications")
	if status != 200 || strings.Contains(notices, "PRIVATE_HOST_RESTORE_CANARY") {
		t.Fatal("idempotent feed replay resurrected content")
	}
	t.Log("actual old SQLite VACUUM snapshot restored; unchanged real Loom authoritative journal reconciled before projection/history reads; offline feed fail-closed; RSS and user-authored question preserved; synthetic platform/model only")
}
