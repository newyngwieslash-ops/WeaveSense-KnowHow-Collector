package flow

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"yingce/backend/internal/model"
)

func TestLongInputProfileHTTPRequiresIdempotencyBeforeForwarding(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := &videoRouteRecorder{}
	router := gin.New()
	registerVideoRoutes(router.Group("/api/intelligence"), testDB(t), engine, Config{EngineURL: "http://unused.fixture", SigningKey: key}, func(*gin.Context) (Scope, *model.User, bool) {
		return Scope{TenantID: "tenant", WorkspaceID: "workspace", Role: "admin"}, &model.User{ID: "alice"}, true
	})
	body := `{"name":"Synthetic long subtitle acceptance","config":{"language":"zh","required_capabilities":["transcript"],"budget_micro":10000,"knowledge_budget_micro":0,"knowledge_model_id":""}}`
	for _, idem := range []string{"", "long-input-profile-fixture"} {
		req := httptest.NewRequest("POST", "/api/intelligence/video/profiles", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Idempotency-Key", idem)
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		if idem == "" {
			var response struct {
				Code   int    `json:"code"`
				Reason string `json:"reason"`
			}
			if err := json.Unmarshal(res.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if res.Code != 400 || response.Code != 400 || response.Reason != "idempotency_key_required" || len(engine.paths) != 0 {
				t.Fatalf("missing key crossed the host boundary: %d %+v %#v", res.Code, response, engine.paths)
			}
		} else if res.Code != 200 || len(engine.paths) != 1 || engine.paths[0] != "POST /v1/video/profiles" || engine.keys[0] != idem {
			t.Fatalf("explicit key not forwarded: %d %#v %#v", res.Code, engine.paths, engine.keys)
		}
	}
}
