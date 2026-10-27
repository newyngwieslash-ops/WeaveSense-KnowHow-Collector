package flow

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"yingce/backend/internal/model"
)

func TestVideoEmbeddingRealLoomStageGatewayAndReadyBarrier(t *testing.T) {
	if os.Getenv("FLOW_VIDEO_CROSSLAYER_TEST") != "1" {
		t.Skip("set FLOW_VIDEO_CROSSLAYER_TEST=1 with Loom dependencies installed")
	}
	db := testDB(t)
	scope, err := ResolveScope(db, "u_alice", "")
	if err != nil {
		t.Fatal(err)
	}
	fund(t, Billing{DB: db}, "u_alice", 2000000)
	t.Setenv("FLOW_PRICE_BOOK", `{"version":"fixture-v1","unit_micro":{"asr_seconds":100,"ocr_pages":2000}}`)
	var modelCalls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		modelCalls.Add(1)
		var body struct {
			Model string   `json:"model"`
			Input []string `json:"input"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if r.URL.Path != "/embeddings" || body.Model != "fixture-embedding" || len(body.Input) == 0 || r.Header.Get("X-Flow-Reservation-Id") == "" {
			t.Error("embedding gateway contract bypassed")
		}
		data := []any{}
		for i := range body.Input {
			data = append(data, map[string]any{"index": i, "embedding": []float64{1, 0.5, 0.25}})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"model": "fixture-embedding", "data": data, "usage": map[string]any{"prompt_tokens": 7 * len(data), "total_tokens": 7 * len(data)}})
	}))
	defer provider.Close()
	gw := &OpenAICompatGateway{URL: provider.URL, Model: "fixture-chat", MicroPer1KTok: 1000, EmbeddingModel: "fixture-embedding", EmbeddingMicroPer1KTok: 1000, EmbeddingDimensions: 3, HTTP: provider.Client()}
	var router atomic.Pointer[gin.Engine]
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if current := router.Load(); current != nil {
			current.ServeHTTP(w, r)
		} else {
			w.WriteHeader(503)
		}
	}))
	defer host.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	node := os.Getenv("VIDEO_QA_NODE")
	if node == "" {
		node = "node"
	}
	cmd := exec.CommandContext(ctx, node, "--experimental-strip-types", "validation/video-knowledge/gateway-embedding-harness.ts")
	cmd.Dir = filepath.Join("..", "..", "..", "services", "loom-engine")
	cmd.Env = append(os.Environ(), "VIDEO_QA_SIGNING_KEY="+string(key), "VIDEO_QA_HOST_URL="+host.URL, "VIDEO_QA_TENANT="+scope.TenantID, "VIDEO_QA_WORKSPACE="+scope.WorkspaceID, "FLOW_VIDEO_ENABLED=true")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Signal(os.Interrupt); _ = cmd.Wait() })
	lines := bufio.NewScanner(stdout)
	lines.Buffer(make([]byte, 65536), 2<<20)
	if !lines.Scan() || !strings.HasPrefix(lines.Text(), "http://127.0.0.1:") {
		t.Fatalf("Loom startup failed: %s", lines.Text())
	}
	t.Setenv("LOOM_ENGINE_URL", lines.Text())
	t.Setenv("FLOW_INTERNAL_JWT_SIGNING_KEY", string(key))
	r := gin.New()
	RegisterP5Routes(r.Group("/api"), db, ConfigFromEnv(), func(*gin.Context) (*model.User, error) { return nil, ErrForbidden }, gw)
	router.Store(r)
	workerCtx, stopWorker := context.WithCancel(ctx)
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		tick := time.NewTicker(20 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-workerCtx.Done():
				return
			case <-tick.C:
				_, _ = (ModelTasks{DB: db, GW: gw}).RunDue(workerCtx)
			}
		}
	}()
	defer func() { stopWorker(); <-workerDone }()
	_, _ = stdin.Write([]byte("go\n"))
	_ = stdin.Close()
	if !lines.Scan() {
		t.Fatalf("Loom fixture did not return: %v", lines.Err())
	}
	var result struct {
		Job struct {
			State           string `json:"state"`
			CompletionLevel string `json:"completion_level"`
		} `json:"job"`
		Ready         []map[string]any `json:"ready"`
		Vectors       []map[string]any `json:"vectors"`
		Batches       []map[string]any `json:"batches"`
		ReadyBefore   int              `json:"ready_before_embedding"`
		ReservationID string           `json:"reservation_id"`
		UsageWorker   struct {
			Phase    string   `json:"phase"`
			Receipts []string `json:"usage_receipts"`
			Restart  bool     `json:"process_restart"`
			Denied   int      `json:"cap_denial"`
		} `json:"usage_worker"`
	}
	if err := json.Unmarshal(lines.Bytes(), &result); err != nil {
		t.Fatalf("fixture response: %v %s", err, lines.Text())
	}
	if result.Job.CompletionLevel != "knowledge_ready" || result.Job.State != "completed" || result.ReadyBefore != 0 || len(result.Ready) != 1 || len(result.Vectors) == 0 || len(result.Batches) == 0 || modelCalls.Load() != 1 {
		t.Fatalf("real embedding barrier failed: %s calls=%d", lines.Text(), modelCalls.Load())
	}
	var parent model.FlowBudgetReservation
	db.First(&parent, "id = ?", result.ReservationID)
	if parent.ConsumedMicro <= 0 || parent.AllocatedMicro != 0 {
		t.Fatalf("actual host cost not rolled up: %+v", parent)
	}
	var tasks []model.FlowModelTask
	db.Where("purpose = ?", "video_embedding").Find(&tasks)
	if len(tasks) != 1 || tasks[0].Status != "succeeded" || tasks[0].CostMicro+2200 != parent.ConsumedMicro {
		t.Fatalf("not one real budgeted task: %+v", tasks)
	}
	var usage []model.FlowUsageRecord
	db.Where("usage_type IN ?", []string{UsageASRSeconds, UsageOCRPages}).Find(&usage)
	if len(usage) != 2 || usage[0].CostMicro+usage[1].CostMicro != 2200 || result.UsageWorker.Phase != "recovered_without_recompute" || !result.UsageWorker.Restart || result.UsageWorker.Denied != 402 || len(result.UsageWorker.Receipts) != 2 {
		t.Fatalf("worker receipt restart/host cumulative cost not proven: %+v usage=%+v", result.UsageWorker, usage)
	}
}
