package flow

import (
	"context"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"yingce/backend/internal/model"
)

type videoRouteRecorder struct {
	paths []string
	keys  []string
}

func TestVideoMCPForwardsBoundedConflictContinuation(t *testing.T) {
	method, path, body := videoMCPRoute("video_result_read", map[string]any{"video_job_id": "vj_fixture", "kind": "visual", "record_id": "r1", "text_offset": 2400, "conflict_offset": 2, "text_field": "audio"})
	u, err := url.Parse(path)
	if err != nil || method != "GET" || body != nil || u.Path != "/v1/video/jobs/vj_fixture/result" || u.Query().Get("conflict_offset") != "2" || u.Query().Get("text_field") != "audio" || u.Query().Get("text_offset") != "2400" {
		t.Fatalf("continuation lost: %s %s", method, path)
	}
	for _, tool := range videoMCPTools() {
		if tool.name == "video_result_read" {
			properties := tool.schema["properties"].(map[string]any)
			if properties["conflict_offset"].(map[string]any)["maximum"] != 8 {
				t.Fatal("unbounded conflict offset")
			}
		}
	}
}

func (r *videoRouteRecorder) Do(_ context.Context, s Scope, a Actor, method, path, key string, _ []byte) (int, []byte, error) {
	if s.TenantID != "tenant" || s.WorkspaceID != "workspace" || a.ID != "alice" {
		return 403, []byte(`{}`), nil
	}
	r.paths = append(r.paths, method+" "+path)
	r.keys = append(r.keys, key)
	return 200, []byte(`{"code":0,"data":{"items":[]}}`), nil
}

func TestVideoInsightsAndOriginReviewProxyBoundaries(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := &videoRouteRecorder{}
	role := "admin"
	router := gin.New()
	registerVideoRoutes(router.Group("/api/intelligence"), testDB(t), engine, Config{EngineURL: "http://unused.fixture", SigningKey: key}, func(*gin.Context) (Scope, *model.User, bool) {
		return Scope{TenantID: "tenant", WorkspaceID: "workspace", Role: role}, &model.User{ID: "alice"}, true
	})
	request := func(method, path, body, idem string, want int) {
		t.Helper()
		req := httptest.NewRequest(method, "/api/intelligence"+path, strings.NewReader(body))
		req.Header.Set("X-Idempotency-Key", idem)
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		if res.Code != want {
			t.Fatalf("%s %s => %d %s", method, path, res.Code, res.Body.String())
		}
	}
	request("GET", "/video/metrics?profile_id=p1", "", "", 200)
	request("GET", "/knowledge/origin-candidates?limit=10", "", "", 200)
	request("POST", "/knowledge/origin-candidates/oc_fixture/review", `{}`, "", 400)
	request("POST", "/knowledge/origin-candidates/oc_fixture/review", `{"tenant_id":"forged"}`, "review-1", 400)
	request("POST", "/knowledge/origin-candidates/oc_fixture/review", `{"decision":"same_origin"}`, "review-1", 200)
	request("POST", "/video/jobs/vj_fixture/repair", `{}`, "", 400)
	request("POST", "/video/jobs/vj_fixture/repair", `{}`, "repair-1", 200)
	request("POST", "/video/retention/preview", `{"action":"revoked","source_id":"s1"}`, "preview-1", 200)
	request("POST", "/video/retention/batch", `{"items":[]}`, "", 400)
	request("POST", "/video/retention/batch", `{"items":[]}`, "batch-1", 200)
	role = "viewer"
	request("GET", "/knowledge/origin-candidates", "", "", 403)
	request("POST", "/knowledge/origin-candidates/oc_fixture/review", `{}`, "review-2", 403)
	request("POST", "/video/retention/preview", `{"action":"revoked","source_id":"s1"}`, "preview-2", 403)
	request("GET", "/video/metrics", "", "", 200)
	if len(engine.paths) != 7 || engine.paths[2] != "POST /v1/knowledge/origin-candidates/oc_fixture/review" || engine.keys[2] != "review-1" || engine.paths[3] != "POST /v1/video/jobs/vj_fixture/repair" || engine.paths[5] != "POST /v1/video/retention/batch" {
		t.Fatalf("proxy contract: %#v %#v", engine.paths, engine.keys)
	}
}
