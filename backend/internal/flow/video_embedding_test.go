package flow

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"yingce/backend/internal/model"
)

func TestVideoEmbeddingRealGatewayBillingAndMissingUsageHold(t *testing.T) {
	db := testDB(t)
	scope, err := ResolveScope(db, "u_alice", "")
	if err != nil {
		t.Fatal(err)
	}
	fund(t, Billing{DB: db}, "u_alice", 200000)
	parent, err := (Billing{DB: db}).Reserve(scope.TenantID, "embedding-parent", "schedule_window", "embedding-job", 100000)
	if err != nil {
		t.Fatal(err)
	}
	loom := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claim, e := Verify(key, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), "loom-engine", time.Now())
		if e != nil || claim.JobID != "embedding-job" || r.URL.Query().Get("purpose") != "video_embedding" {
			w.WriteHeader(403)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{"allowed": true, "grant_actor": "user:u_alice", "budget_reservation_id": parent.ID}})
	}))
	defer loom.Close()
	t.Setenv("LOOM_ENGINE_URL", loom.URL)
	t.Setenv("FLOW_INTERNAL_JWT_SIGNING_KEY", string(key))
	var calls atomic.Int32
	var missingUsage atomic.Bool
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if r.URL.Path != "/embeddings" || r.Header.Get("Idempotency-Key") == "" || r.Header.Get("X-Flow-Reservation-Id") == "" || body["model"] != "fixture-embedding" {
			t.Error("embedding bypassed managed gateway")
		}
		out := map[string]any{"model": "fixture-embedding", "data": []any{map[string]any{"index": 1, "embedding": []float64{0, 1, 0}}, map[string]any{"index": 0, "embedding": []float64{1, 0, 0}}}}
		if !missingUsage.Load() {
			out["usage"] = map[string]any{"prompt_tokens": 12, "total_tokens": 12}
		}
		_ = json.NewEncoder(w).Encode(out)
	}))
	defer provider.Close()
	gw := &OpenAICompatGateway{URL: provider.URL, Model: "unused-chat", MicroPer1KTok: 1000, EmbeddingModel: "fixture-embedding", EmbeddingMicroPer1KTok: 1000, EmbeddingDimensions: 3, HTTP: provider.Client()}
	router := gin.New()
	registerVideoModelRoutes(router.Group("/api"), db, ConfigFromEnv(), gw)
	token, _ := Sign(key, ExecutionContext{Issuer: "loom-engine", Audience: "flow-platform", TenantID: scope.TenantID, WorkspaceID: scope.WorkspaceID, JobID: "embedding-job", Actor: Actor{Type: "service_principal", ID: "loom-video-indexer"}, Scopes: []string{"intel.video.model"}}, time.Now(), time.Minute)
	text := func(id, body string) map[string]any {
		hash := sha256.Sum256([]byte(body))
		return map[string]any{"chunk_id": id, "text": body, "sha256": hex.EncodeToString(hash[:])}
	}
	inputs := []any{text("chunk-1", "Frozen source material."), text("chunk-2", "Synthetic embedding fixture.")}
	request := map[string]any{"key": "batch-1", "purpose": "video_embedding", "model_id": "fixture-embedding", "input": map[string]any{"texts": inputs}, "budget_micro": 10000, "max_tokens": 1, "stage_attempt": 1, "fencing_token": 1}
	call := func() (int, map[string]any) {
		req := httptest.NewRequest("POST", "/api/internal/flow/video/model-tasks", bytes.NewReader(mustJSON(request)))
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		var env struct {
			Data map[string]any `json:"data"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &env)
		return w.Code, env.Data
	}
	request["budget_micro"] = 1
	if code, _ := call(); code != 402 {
		t.Fatal("underestimated embedding budget admitted")
	}
	request["budget_micro"] = 10000
	code, created := call()
	if code != 202 {
		t.Fatalf("embedding enqueue %d %+v", code, created)
	}
	id := created["task_id"].(string)
	if _, err := (ModelTasks{DB: db, GW: gw}).RunTask(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	var task model.FlowModelTask
	db.First(&task, "id = ?", id)
	if task.Status != "succeeded" || task.CostMicro != 12 || !strings.Contains(task.Result, "chunk-2") || calls.Load() != 1 {
		t.Fatalf("actual embedding: %+v calls=%d", task, calls.Load())
	}
	if code, replayed := call(); code != 200 || replayed["task_id"] != id {
		t.Fatal("embedding replay lost receipt")
	}
	var usage []model.FlowUsageRecord
	db.Where("subject_ref = ?", "model_task:"+id).Find(&usage)
	if len(usage) != 2 || usage[0].CostMicro+usage[1].CostMicro != 12 {
		t.Fatalf("actual embedding usage missing %+v", usage)
	}
	request["key"] = "batch-unknown"
	missingUsage.Store(true)
	code, unknown := call()
	if code != 202 {
		t.Fatal(code)
	}
	unknownID := unknown["task_id"].(string)
	_, _ = (ModelTasks{DB: db, GW: gw}).RunTask(context.Background(), unknownID)
	var pending model.FlowModelTask
	db.First(&pending, "id = ?", unknownID)
	if pending.Status != StatusReconciliation {
		t.Fatal("missing billed usage silently became free success")
	}
	_, _ = (ModelTasks{DB: db, GW: gw}).RunTask(context.Background(), unknownID)
	if calls.Load() != 2 {
		t.Fatal("unknown embedding retried paid work")
	}
	if _, err := (Billing{DB: db}).Settle(parent.ID, 0); err == nil {
		t.Fatal("unknown embedding released cumulative hold")
	}
	inputs[0].(map[string]any)["sha256"] = strings.Repeat("f", 64)
	request["key"] = "tampered"
	if code, _ := call(); code != 400 {
		t.Fatal("tampered embedding chunk accepted")
	}
}
