package flow

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"yingce/backend/internal/model"
)

func TestVideoUsageAdmissionCumulativeCapFrozenPriceAndUnknownHold(t *testing.T) {
	db := testDB(t)
	scope, err := ResolveScope(db, "u_alice", "")
	if err != nil {
		t.Fatal(err)
	}
	fund(t, Billing{DB: db}, "u_alice", 100000)
	parent, err := (Billing{DB: db}).Reserve(scope.TenantID, "profile-cap", "schedule_window", "meter-job", 1000)
	if err != nil {
		t.Fatal(err)
	}
	loom := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claim, e := Verify(key, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), "loom-engine", time.Now())
		if e != nil || claim.JobID != "meter-job" {
			w.WriteHeader(403)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{"allowed": true, "grant_actor": "user:u_alice", "budget_reservation_id": parent.ID}})
	}))
	defer loom.Close()
	cfg := Config{EngineURL: loom.URL, SigningKey: key, Issuer: "flow-platform", Audience: "loom-engine", TTL: MaxTokenTTL}
	router := gin.New()
	registerVideoUsageRoutes(router.Group("/api"), db, cfg)
	token, _ := Sign(key, ExecutionContext{Issuer: "loom-engine", Audience: "flow-platform", TenantID: scope.TenantID, WorkspaceID: scope.WorkspaceID, JobID: "meter-job", Actor: Actor{Type: "service_principal", ID: "loom-video-worker"}, Scopes: []string{"intel.video.model"}}, time.Now(), time.Minute)
	call := func(path string, body any) (int, map[string]any) {
		t.Helper()
		method := "POST"
		if body == nil {
			method = "GET"
		}
		req := httptest.NewRequest(method, "/api/internal/flow/video/"+path, bytes.NewReader(mustJSON(body)))
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		var env struct {
			Data map[string]any `json:"data"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &env)
		return w.Code, env.Data
	}
	admit := func(k string, q int) (int, map[string]any) {
		return call("usage-admission", map[string]any{"key": k, "usage_type": "asr_seconds", "quantity": q, "stage_attempt": 1, "fencing_token": 1})
	}
	settle := func(id string, q int, outcome string) (int, map[string]any) {
		return call("usage-settle", map[string]any{"admission_id": id, "quantity": q, "outcome": outcome, "stage_attempt": 1, "fencing_token": 1})
	}
	code, first := admit("chunk-a", 8)
	if code != 200 {
		t.Fatalf("admit: %d %+v", code, first)
	}
	id := first["admission_id"].(string)
	if code, _ := admit("chunk-b", 3); code != 402 {
		t.Fatal("parallel work exceeded parent cap")
	}
	if code, _ := admit("chunk-a", 9); code != 409 {
		t.Fatal("same key changed quantum")
	}
	if code, _ := settle(id, 9, "completed"); code != 409 {
		t.Fatal("settled over admitted quantity")
	}
	t.Setenv("FLOW_PRICE_BOOK", `{"version":"new-price","unit_micro":{"asr_seconds":10000}}`)
	if code, row := admit("chunk-a", 8); code != 200 || row["unit_price_micro"] != float64(100) {
		t.Fatal("replay repriced frozen admission")
	}
	if code, row := settle(id, 5, "completed"); code != 200 || row["cost_micro"] != float64(500) {
		t.Fatalf("true settle: %d %+v", code, row)
	}
	if code, _ := settle(id, 5, "completed"); code != 200 {
		t.Fatal("settlement replay failed")
	}
	t.Setenv("FLOW_PRICE_BOOK", "")
	code, unknown := admit("chunk-b", 4)
	if code != 200 {
		t.Fatalf("remaining cap: %d", code)
	}
	uid := unknown["admission_id"].(string)
	if code, _ := settle(uid, 0, "unknown"); code != 200 {
		t.Fatal("unknown not retained")
	}
	if _, err := (Billing{DB: db}).Settle(parent.ID, 0); err == nil {
		t.Fatal("unknown child released parent")
	}
	if code, view := call("budget", nil); code != 200 || view["unknown_children"] != float64(1) || view["remaining_micro"] != float64(100) {
		t.Fatalf("budget snapshot %d %+v", code, view)
	}
	if code, _ := settle(uid, 2, "completed"); code != 200 {
		t.Fatal("known outcome did not settle prior hold")
	}
	closed, err := (Billing{DB: db}).Settle(parent.ID, 0)
	if err != nil || closed.ConsumedMicro != 700 {
		t.Fatalf("cumulative actual %d %v", closed.ConsumedMicro, err)
	}
	var records []model.FlowUsageRecord
	db.Where("subject_ref = ?", "video_job:meter-job").Find(&records)
	if len(records) != 2 || records[0].CostMicro+records[1].CostMicro != 700 {
		t.Fatalf("usage doublecharge: %+v", records)
	}
}
