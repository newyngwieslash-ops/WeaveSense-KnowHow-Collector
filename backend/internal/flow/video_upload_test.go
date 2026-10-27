package flow

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"yingce/backend/internal/model"
)

func TestVideoLawfulInputStreamsUserAuthorityOnly(t *testing.T) {
	gin.SetMode(gin.TestMode)
	requests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		claim, err := Verify(key, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), "loom-engine", time.Now())
		if err != nil || claim.Actor.Type != "user" || claim.Actor.ID != "alice" || claim.JobID != "vj_input" || claim.WorkspaceID != "workspace" || len(claim.Scopes) != 1 || !claim.HasScope("intel.video.process") {
			t.Error("upload authority mismatch", claim, err)
			w.WriteHeader(403)
			return
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != "lawful fixture" || r.ContentLength != 14 || r.Header.Get("Content-Type") != "text/vtt" || r.Header.Get("Cookie") != "" || r.URL.Path != "/v1/video/jobs/vj_input/input" {
			t.Error("stream contract mismatch", string(body), r.Header)
		}
		_, _ = io.WriteString(w, `{"code":0,"data":{"video_job_id":"vj_input","input_received":true}}`)
	}))
	defer upstream.Close()
	cfg := Config{EngineURL: upstream.URL, SigningKey: key, Issuer: "flow-platform", Audience: "loom-engine"}
	router := gin.New()
	registerVideoUpload(router.Group("/api/intelligence"), cfg, func(*gin.Context) (Scope, *model.User, bool) {
		return Scope{TenantID: "tenant", WorkspaceID: "workspace", Role: "admin"}, &model.User{ID: "alice"}, true
	})
	for _, size := range []int64{14, 0, 2<<30 + 1} {
		req := httptest.NewRequest("PUT", "/api/intelligence/video/jobs/vj_input/input", strings.NewReader("lawful fixture"))
		req.ContentLength = size
		req.Header.Set("Content-Type", "text/vtt")
		req.Header.Set("Cookie", "private browser session")
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		want := 200
		if size == 0 {
			want = 411
		}
		if size > 2<<30 {
			want = 413
		}
		if out.Code != want {
			t.Fatalf("size %d status %d: %s", size, out.Code, out.Body.String())
		}
	}
	if requests != 1 {
		t.Fatal("invalid upload reached Loom", requests)
	}
}

func TestVideoMediaRangeUsesCurrentUserWorkspaceSelector(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := testDB(t)
	scope, err := ResolveScope(db, "u_alice", "")
	if err != nil {
		t.Fatal(err)
	}
	requests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		claim, e := Verify(key, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), "loom-engine", time.Now())
		if e != nil || claim.Actor.Type != "user" || claim.Actor.ID != "u_alice" || claim.WorkspaceID != scope.WorkspaceID || claim.JobID != "vj_media" || !claim.HasScope("intel.video.read") || r.Header.Get("Range") != "bytes=1-3" || r.Header.Get("Cookie") != "" {
			t.Error("media boundary", claim, e)
			w.WriteHeader(403)
			return
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Length", "3")
		w.Header().Set("Content-Range", "bytes 1-3/5")
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("ETag", `"fixture-sha"`)
		w.WriteHeader(206)
		_, _ = io.WriteString(w, "bcd")
	}))
	defer upstream.Close()
	router := gin.New()
	RegisterRoutes(router.Group("/api"), db, Config{EngineURL: upstream.URL, SigningKey: key, Issuer: "flow-platform", Audience: "loom-engine"}, func(*gin.Context) (*model.User, error) { return &model.User{ID: "u_alice"}, nil })
	get := func(workspace, rangeHeader string, want int) {
		t.Helper()
		req := httptest.NewRequest("GET", "/api/intelligence/video/jobs/vj_media/media/"+strings.Repeat("a", 32)+"?workspace_id="+workspace, nil)
		req.Header.Set("Range", rangeHeader)
		req.Header.Set("Cookie", "private")
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		if out.Code != want {
			t.Fatalf("media status%d want%d %s", out.Code, want, out.Body.String())
		}
		if want == 206 && (out.Body.String() != "bcd" || out.Header().Get("Content-Range") != "bytes 1-3/5" || out.Header().Get("Cache-Control") != "private, no-store") {
			t.Fatal("range streaming headers/body", out)
		}
	}
	get(scope.WorkspaceID, "bytes=1-3", 206)
	get(scope.WorkspaceID, "bytes=1-3,4-5", 416)
	get(model.PersonalWorkspaceID("u_bob"), "bytes=1-3", 404)
	if err = db.Model(&model.Membership{}).Where("tenant_id = ? AND user_id = ?", scope.TenantID, "u_alice").Update("status", "revoked").Error; err != nil {
		t.Fatal(err)
	}
	get(scope.WorkspaceID, "bytes=1-3", 404)
	if requests != 1 {
		t.Fatal("unauthorized or malformed read reached Loom", requests)
	}
}
