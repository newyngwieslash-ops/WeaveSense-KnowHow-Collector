package flow

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"yingce/backend/internal/model"
)

func TestVideoModelBudgetUsageIdempotencyAndRevocation(t *testing.T) {
	db := testDB(t)
	scope, err := ResolveScope(db, "u_alice", "")
	if err != nil {
		t.Fatal(err)
	}
	fund(t, Billing{DB: db}, "u_alice", 2_000_000)
	parent, err := (Billing{DB: db}).Reserve(scope.TenantID, "video-profile-budget", "schedule_window", "job-1", 100000)
	if err != nil {
		t.Fatal(err)
	}
	revoked := &atomic.Bool{}
	loom := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claim, err := Verify(key, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), "loom-engine", time.Now())
		if err != nil || claim.JobID != "job-1" || !claim.HasScope("intel.video.model") || revoked.Load() {
			w.WriteHeader(403)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{"allowed": true, "grant_actor": "user:u_alice", "budget_reservation_id": parent.ID}})
	}))
	defer loom.Close()
	t.Setenv("LOOM_ENGINE_URL", loom.URL)
	t.Setenv("FLOW_INTERNAL_JWT_SIGNING_KEY", string(key))
	calls := &atomic.Int32{}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Idempotency-Key") == "" || r.Header.Get("X-Flow-Reservation-Id") == "" {
			t.Error("provider call escaped managed billing")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": `{"summary":"fixture","input_ids":["segment-1"],"limitations":[]}`}}}, "usage": map[string]any{"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30}})
	}))
	defer provider.Close()
	gw := &OpenAICompatGateway{URL: provider.URL, Model: "fixture-model", MicroPer1KTok: 1000, HTTP: provider.Client()}
	cfg := ConfigFromEnv()
	router := gin.New()
	registerVideoModelRoutes(router.Group("/api"), db, cfg, gw)
	token, _ := Sign(key, ExecutionContext{Issuer: "loom-engine", Audience: "flow-platform", TenantID: scope.TenantID, WorkspaceID: scope.WorkspaceID, JobID: "job-1", Actor: Actor{Type: "service_principal", ID: "loom-video-worker"}, Scopes: []string{"intel.video.model"}}, time.Now(), time.Minute)
	call := func(input map[string]any) (int, map[string]any) {
		t.Helper()
		req := httptest.NewRequest("POST", "/api/internal/flow/video/model-tasks", bytes.NewReader(mustJSON(input)))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		var env struct {
			Data map[string]any `json:"data"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &env)
		return w.Code, env.Data
	}
	input := map[string]any{"key": "summary-1", "purpose": "video_summary", "model_id": "fixture-model", "input": map[string]any{"input_id": "segment-1", "text": "Fixture text."}, "budget_micro": 10000, "max_tokens": 500, "stage_attempt": 1, "fencing_token": 1}
	status, data := call(input)
	if status != 202 {
		t.Fatalf("enqueue: %d %+v", status, data)
	}
	taskID := data["task_id"].(string)
	status, replayed := call(input)
	if status != 200 || replayed["task_id"] != taskID {
		t.Fatal("lost create response must recover exact task")
	}
	if _, err := (ModelTasks{DB: db, GW: gw}).RunTask(context.Background(), taskID); err != nil {
		t.Fatal(err)
	}
	var task model.FlowModelTask
	db.First(&task, "id = ?", taskID)
	if task.Status != "succeeded" || task.CostMicro != 30 || calls.Load() != 1 {
		t.Fatalf("task: %+v calls=%d", task, calls.Load())
	}
	input["stage_attempt"], input["fencing_token"] = 2, 2
	if status, rebound := call(input); status != 200 || rebound["task_id"] != taskID {
		t.Fatal("new verified fence did not recover same paid task")
	}
	_, _ = (ModelTasks{DB: db, GW: gw}).RunTask(context.Background(), taskID)
	if calls.Load() != 1 {
		t.Fatal("takeover repeated paid model work")
	}
	input["stage_attempt"], input["fencing_token"] = 1, 1
	if status, _ := call(input); status != 409 {
		t.Fatal("old model fence replaced newer authorization")
	}
	input["stage_attempt"], input["fencing_token"] = 2, 2
	var usage []model.FlowUsageRecord
	db.Where("subject_ref = ?", "model_task:"+taskID).Find(&usage)
	if len(usage) != 2 || usage[0].WorkspaceID != scope.WorkspaceID || usage[1].WorkspaceID != scope.WorkspaceID {
		t.Fatalf("missing true scoped token usage: %+v", usage)
	}
	input["input"] = map[string]any{"text": "changed"}
	if status, _ := call(input); status != 409 {
		t.Fatal("different request reused key")
	}
	input["key"] = "summary-2"
	status, data = call(input)
	if status != 202 {
		t.Fatal(status)
	}
	revoked.Store(true)
	_, _ = (ModelTasks{DB: db, GW: gw}).RunTask(context.Background(), data["task_id"].(string))
	if calls.Load() != 1 {
		t.Fatal("revoked job reached model")
	}
	revoked.Store(false)
	input["key"] = "summary-3"
	input["grant_actor"] = "u_bob"
	if status, _ := call(input); status != 403 {
		t.Fatal("worker spoofed original actor")
	}
}

func TestVideoVisionScopedFrameIntegrityAndEphemeralPayload(t *testing.T) {
	db := testDB(t)
	scope, err := ResolveScope(db, "u_alice", "")
	if err != nil {
		t.Fatal(err)
	}
	fund(t, Billing{DB: db}, "u_alice", 2_000_000)
	parent, err := (Billing{DB: db}).Reserve(scope.TenantID, "vision-profile", "schedule_window", "vision-job", 200000)
	if err != nil {
		t.Fatal(err)
	}
	var pngBytes bytes.Buffer
	if err := png.Encode(&pngBytes, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	imageHash := sha256.Sum256(pngBytes.Bytes())
	sha := hex.EncodeToString(imageHash[:])
	objectKey := "tenants/" + scope.TenantID + "/workspaces/" + scope.WorkspaceID + "/video/vision-job/" + sha + "/frame.png"
	var frameReads, paidCalls atomic.Int32
	loom := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claim, err := Verify(key, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), "loom-engine", time.Now())
		if err != nil || claim.Actor.ID != "video-model-gateway" || claim.JobID != "vision-job" || claim.WorkspaceID != scope.WorkspaceID || !claim.HasScope("intel.video.model") || r.URL.Query().Get("stage_attempt") != "1" || r.URL.Query().Get("fencing_token") != "1" {
			t.Error("frame/model authorization was not scoped to the current job fence")
			w.WriteHeader(403)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/artifacts/raw") {
			frameReads.Add(1)
			if r.URL.Query().Get("object_key") != objectKey {
				t.Error("unexpected frame object")
			}
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(pngBytes.Bytes())
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{"allowed": true, "grant_actor": "user:u_alice", "budget_reservation_id": parent.ID}})
	}))
	defer loom.Close()
	t.Setenv("LOOM_ENGINE_URL", loom.URL)
	t.Setenv("FLOW_INTERNAL_JWT_SIGNING_KEY", string(key))
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paidCalls.Add(1)
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		raw := string(mustJSON(body))
		if !strings.Contains(raw, "data:image/png;base64,") || !strings.Contains(raw, `"type":"image_url"`) || r.Header.Get("X-Flow-Reservation-Id") == "" {
			t.Error("vision did not use scoped bytes through the billed gateway")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": `{"observations":[{"kind":"observation","text":"Synthetic frame only","frame_ids":["frame-1"],"review_status":"unreviewed"}],"limitations":[]}`}}}, "usage": map[string]any{"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30}})
	}))
	defer provider.Close()
	gw := &OpenAICompatGateway{URL: provider.URL, Model: "fixture-vision", MicroPer1KTok: 1000, SupportsVision: true, HTTP: provider.Client()}
	router := gin.New()
	registerVideoModelRoutes(router.Group("/api"), db, ConfigFromEnv(), gw)
	token, _ := Sign(key, ExecutionContext{Issuer: "loom-engine", Audience: "flow-platform", TenantID: scope.TenantID, WorkspaceID: scope.WorkspaceID, JobID: "vision-job", Actor: Actor{Type: "service_principal", ID: "loom-video-worker"}, Scopes: []string{"intel.video.model"}}, time.Now(), time.Minute)
	input := map[string]any{"key": "vision-1", "purpose": "video_vision", "model_id": "fixture-vision", "input": map[string]any{"frame_ids": []string{"frame-1"}}, "frames": []VideoModelFrame{{FrameID: "frame-1", ObjectKey: objectKey, SHA256: sha, TimestampMS: 0}}, "budget_micro": 100000, "max_tokens": 500, "stage_attempt": 1, "fencing_token": 1}
	enqueue := func() string {
		t.Helper()
		req := httptest.NewRequest("POST", "/api/internal/flow/video/model-tasks", bytes.NewReader(mustJSON(input)))
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		var env struct {
			Data struct {
				ID string `json:"task_id"`
			} `json:"data"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &env)
		if w.Code != 202 || env.Data.ID == "" {
			t.Fatalf("vision enqueue: %d %s", w.Code, w.Body.String())
		}
		return env.Data.ID
	}
	id := enqueue()
	if _, err := (ModelTasks{DB: db, GW: gw}).RunTask(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	var task model.FlowModelTask
	db.First(&task, "id = ?", id)
	if task.Status != "succeeded" || task.CostMicro != 30 || paidCalls.Load() != 1 || frameReads.Load() != 1 || strings.Contains(task.Request+task.Context, "base64") {
		t.Fatalf("vision payload/accounting mismatch: %+v", task)
	}
	input["key"] = "vision-integrity-failure"
	input["frames"] = []VideoModelFrame{{FrameID: "frame-1", ObjectKey: objectKey, SHA256: strings.Repeat("0", 64), TimestampMS: 0}}
	badID := enqueue()
	_, _ = (ModelTasks{DB: db, GW: gw}).RunTask(context.Background(), badID)
	if paidCalls.Load() != 1 || frameReads.Load() != 2 {
		t.Fatal("tampered frame reached paid dispatch or was not checked")
	}
}
