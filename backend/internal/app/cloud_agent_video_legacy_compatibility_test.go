package app

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"yingce/backend/internal/flow"
	"yingce/backend/internal/model"
)

// AC24 uses actual Loom coordinator flag states and actual scheduler events, not
// an unused Go environment variable. The gateway and persisted approval in
// t22Setup are explicit fixtures, not a real CloudAgent approval-decision route.
func TestVideoAC24PeriodicCanvasFeatureToggleParity(t *testing.T) {
	if os.Getenv("FLOW_VIDEO_CROSSLAYER_TEST") != "1" {
		t.Skip("set FLOW_VIDEO_CROSSLAYER_TEST=1 with Loom dependencies installed")
	}
	var results []map[string]int64
	for _, enabled := range []string{"false", "true"} {
		t.Run("video_"+enabled, func(t *testing.T) {
			t.Setenv("FLOW_VIDEO_ENABLED", enabled)
			s, db, _, plan, _ := t22Setup(t)
			grant, err := json.Marshal(plan)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()
			node := os.Getenv("VIDEO_QA_NODE")
			if node == "" {
				node = "node"
			}
			cmd := exec.CommandContext(ctx, node, "--experimental-strip-types", "validation/video-knowledge/legacy-cycle-harness.ts")
			cmd.Dir = filepath.Join("..", "..", "..", "services", "loom-engine")
			cmd.Env = os.Environ()
			cmd.Stdin = strings.NewReader(string(grant))
			raw, err := cmd.Output()
			if err != nil {
				if exit, ok := err.(*exec.ExitError); ok {
					t.Fatalf("actual Loom legacy cycle: %v %s", err, exit.Stderr)
				}
				t.Fatal(err)
			}
			var fixture struct {
				VideoEnabled bool         `json:"video_enabled"`
				GatewayCalls int          `json:"gateway_calls"`
				Events       []flow.Event `json:"events"`
			}
			if err = json.Unmarshal(raw, &fixture); err != nil {
				t.Fatal(err)
			}
			if fixture.VideoEnabled != (enabled == "true") || fixture.GatewayCalls != 3 || len(fixture.Events) != 3 {
				t.Fatalf("missing actual flag propagation: %+v", fixture)
			}
			dispatcher := flow.CommandDispatcher{DB: db, Local: map[string]func(context.Context, model.FlowCommandOutbox) (int, []byte, error){flow.MonitorCanvasRunCommand: s.ExecuteMonitorCanvasRun}}
			for index, event := range fixture.Events {
				if created, err := flow.ConsumeMonitorCanvasEvent(db, event); err != nil || !created {
					t.Fatalf("actual event intake: %v %v", created, err)
				}
				if replay, err := flow.ConsumeMonitorCanvasEvent(db, event); err != nil || replay {
					t.Fatalf("actual event replay: %v %v", replay, err)
				}
				if n, err := dispatcher.DispatchDue(ctx, 10); err != nil || n != 1 {
					t.Fatalf("native dispatch: %d %v", n, err)
				}
				if index < 2 {
					deadline := time.Now().Add(15 * time.Second)
					var succeeded int64
					for time.Now().Before(deadline) {
						db.Model(&model.CanvasWorkflowExecution{}).Where("canvas_id = ? AND status = ?", "cv22", "succeeded").Count(&succeeded)
						if succeeded == int64(index+1) {
							break
						}
						time.Sleep(20 * time.Millisecond)
					}
					if succeeded != int64(index+1) {
						t.Fatalf("managed periodic Canvas did not succeed: %d", succeeded)
					}
				}
			}
			var usage model.CanvasMonitorRunUsage
			if err := db.First(&usage, "monitor_id = ?", plan.MonitorID).Error; err != nil {
				t.Fatal(err)
			}
			var executions, exhausted, dispatched int64
			db.Model(&model.CanvasWorkflowExecution{}).Where("canvas_id = ?", "cv22").Count(&executions)
			db.Model(&model.FlowCommandOutbox{}).Where("status = ?", "dispatched").Count(&dispatched)
			db.Model(&model.FlowCommandOutbox{}).Where("response_body LIKE ?", "%monitor_plan_exhausted%").Count(&exhausted)
			if executions != 2 || usage.RunsUsed != 2 || usage.MicroUsed != 2*plan.BudgetMicroPerWindow || exhausted != 1 || dispatched != 3 {
				t.Fatalf("periodic parity drift: executions=%d usage=%+v exhausted=%d dispatched=%d", executions, usage, exhausted, dispatched)
			}
			results = append(results, map[string]int64{"executions": executions, "runs_used": usage.RunsUsed, "micro_used": usage.MicroUsed, "exhausted": exhausted, "dispatched": dispatched})
		})
	}
	if len(results) != 2 || !reflect.DeepEqual(results[0], results[1]) {
		t.Fatalf("feature-toggle results differ: %+v", results)
	}
}
