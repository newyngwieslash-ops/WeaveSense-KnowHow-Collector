package flow

import (
	"bufio"
	"context"
	"encoding/json"
	"github.com/gin-gonic/gin"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"yingce/backend/internal/model"
)

func TestVideoKnowledgeSnapshotUsesRealLoomAndNativeRegistry(t *testing.T) {
	if os.Getenv("FLOW_VIDEO_CROSSLAYER_TEST") != "1" {
		t.Skip("set FLOW_VIDEO_CROSSLAYER_TEST=1 with Loom dependencies installed")
	}
	tools, _, conv, ss := setupP3(t)
	router := gin.New()
	registerVideoModelRoutes(router.Group("/api"), tools.DB, Config{SigningKey: key, Issuer: "flow-platform"}, nil)
	registry := httptest.NewServer(router)
	defer registry.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	node := os.Getenv("VIDEO_QA_NODE")
	if node == "" {
		node = "node"
	}
	cmd := exec.CommandContext(ctx, node, "--experimental-strip-types", "validation/video-knowledge/gateway-loom-harness.ts")
	cmd.Dir = filepath.Join("..", "..", "..", "services", "loom-engine")
	cmd.Env = append(os.Environ(), "VIDEO_QA_SIGNING_KEY="+string(key), "VIDEO_QA_HOST_URL="+registry.URL, "FLOW_VIDEO_ENABLED=true")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Signal(os.Interrupt); _ = cmd.Wait() })
	scanner := bufio.NewScanner(stdout)
	if !scanner.Scan() {
		t.Fatal("Loom did not start")
	}
	endpoint := scanner.Text()
	if !strings.HasPrefix(endpoint, "http://127.0.0.1:") {
		t.Fatal(endpoint)
	}
	t.Setenv("LOOM_ENGINE_URL", endpoint)
	t.Setenv("FLOW_INTERNAL_JWT_SIGNING_KEY", string(key))
	tools.Engine = EngineClient{Cfg: ConfigFromEnv()}
	if _, err = InstallSkill(tools.DB, ss.Scope, "u_alice", "video-knowledge-core", "1.0.0"); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadSkillForRun(tools.DB, ss.Scope, tools.RunID, "video-knowledge-core")
	if err != nil || loaded.KnowledgeSnapshot == nil {
		t.Fatalf("actual snapshot pin: %+v %v", loaded, err)
	}
	if skillHash(loaded) != loaded.Hash {
		t.Fatal("runtime snapshot polluted source-controlled native hash")
	}
	again, err := LoadSkillForRun(tools.DB, ss.Scope, tools.RunID, "video-knowledge-core")
	if err != nil || *again.KnowledgeSnapshot != *loaded.KnowledgeSnapshot {
		t.Fatalf("same run snapshot drifted: %+v %v", again, err)
	}
	search, err := tools.Invoke(ctx, conv, ss, "u_alice", "snapshot-search", "intel_search_knowledge", map[string]any{"query": "fixture"}, "")
	if err != nil || search.Status != "succeeded" {
		t.Fatalf("native frozen search: %+v %v", search, err)
	}
	if _, err = tools.Invoke(ctx, conv, ss, "u_alice", "forged-snapshot", "intel_search_knowledge", map[string]any{"query": "fixture", "snapshot_id": "forged"}, ""); err == nil {
		t.Fatal("model selected its own knowledge snapshot")
	}
}

func TestVideoReadyActualLoomEventCreatesOnlyOneCanvasCommand(t *testing.T) {
	if os.Getenv("FLOW_VIDEO_CROSSLAYER_TEST") != "1" {
		t.Skip("set FLOW_VIDEO_CROSSLAYER_TEST=1 with Loom dependencies installed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	node := os.Getenv("VIDEO_QA_NODE")
	if node == "" {
		node = "node"
	}
	cmd := exec.CommandContext(ctx, node, "--experimental-strip-types", "validation/video-knowledge/gateway-loom-harness.ts")
	cmd.Dir = filepath.Join("..", "..", "..", "services", "loom-engine")
	cmd.Env = append(os.Environ(), "VIDEO_QA_SIGNING_KEY="+string(key), "VIDEO_QA_READY_FIXTURE=1", "FLOW_VIDEO_ENABLED=true")
	raw, err := cmd.Output()
	if err != nil {
		if e, ok := err.(*exec.ExitError); ok {
			t.Fatalf("actual ready fixture: %v %s", err, e.Stderr)
		}
		t.Fatal(err)
	}
	var fixture struct {
		Events    []Event `json:"events"`
		MonitorID string  `json:"monitor_id"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("event JSON: %v %s", err, raw)
	}
	db := testDB(t)
	if err := db.AutoMigrate(&model.FlowCommandOutbox{}, &model.FlowEventInbox{}); err != nil {
		t.Fatal(err)
	}
	discovery, perDocument, cycle, enqueued := 0, 0, 0, 0
	for _, event := range fixture.Events {
		var payload MonitorCanvasEventPayload
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		created, err := ConsumeMonitorCanvasEvent(db, event)
		if err != nil {
			t.Fatal(err)
		}
		if created {
			enqueued++
		}
		if event.Type == "collection.completed" {
			discovery++
			if created {
				t.Fatal("discovery prematurely triggered Canvas")
			}
		}
		if event.Type == "video.knowledge_ready" && !payload.CycleComplete {
			perDocument++
			if created {
				t.Fatal("per-document ready prematurely triggered Canvas")
			}
		}
		if event.Type == "video.knowledge_ready" && payload.CycleComplete {
			cycle++
			if !created {
				t.Fatal("real completed ready cycle did not trigger Canvas")
			}
		}
		if duplicate, err := ConsumeMonitorCanvasEvent(db, event); err != nil || duplicate {
			t.Fatalf("duplicate event retriggered: %v %v", duplicate, err)
		}
	}
	if discovery != 1 || perDocument != 1 || cycle != 1 || enqueued != 1 {
		t.Fatalf("missing actual transition: discovery=%d document=%d cycle=%d enqueued=%d", discovery, perDocument, cycle, enqueued)
	}
	var command model.FlowCommandOutbox
	if err := db.First(&command, "command = ?", MonitorCanvasRunCommand).Error; err != nil {
		t.Fatal(err)
	}
	if command.TenantID != "ready_t" || command.WorkspaceID != "ready_w" || !strings.Contains(command.Payload, fixture.MonitorID) || !strings.Contains(command.Payload, "qa-canvas") {
		t.Fatalf("scope/grant projection drift: %+v", command)
	}
}
