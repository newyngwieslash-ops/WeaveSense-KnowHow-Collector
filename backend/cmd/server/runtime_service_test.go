package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"yingce/backend/internal/database"
	"yingce/backend/internal/flow"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

func TestRuntimeServiceGuardedDBDrivesActualApprovedNativeSkill(t *testing.T) {
	oldDB, err := database.Open(database.Config{Driver: "sqlite", DSN: filepath.Join(t.TempDir(), "runtime.db") + "?_journal_mode=WAL&_busy_timeout=5000"})
	if err != nil {
		t.Fatal(err)
	}
	if err = database.MigrateSchema(oldDB); err != nil {
		t.Fatal(err)
	}
	sqlDB, err := oldDB.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	svc, db := newRuntimeService(repository.New(oldDB), t.TempDir())
	t.Cleanup(func() { _ = svc.Close() })
	executions := svc.CanvasWorkflowExecutions()
	if db == oldDB || executions.DB != db {
		t.Fatal("composition must retain the guarded service session, not the original DB")
	}
	// This is the exact pre-fix composition. Strict identity remains fail-closed.
	badRunner := flow.CanvasWorkflowManagedRunner{Tools: flow.Tools{DB: oldDB}}
	if err = badRunner.Run(context.Background(), executions, model.CanvasWorkflowExecution{ID: "diagnostic", UserID: "user"}); !errors.Is(err, flow.ErrInvalid) {
		t.Fatalf("unguarded composition no longer rejected: %v", err)
	}
	for _, row := range []any{&model.User{ID: "user", Username: "synthetic-runtime"}, &model.CreditAccount{UserID: "user", AvailableMicrocredits: 1_000_000}} {
		if err = db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	scope, err := flow.ResolveScope(db, "user", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = (flow.Billing{DB: db}).Account(db, scope.TenantID); err != nil {
		t.Fatal(err)
	}
	installed, err := flow.InstallSkill(db, scope, "user", "periodic-brief", "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	// Only external model output and evidence-resolution HTTP bytes are fixtures.
	// Native registry, actual CloudAgent approval, managed execution, ModelTasks,
	// billing, pins and Canvas write-back are the production implementations.
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/evidence/resolve" {
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"evidence_id": "synthetic-evidence", "revision": 1, "document_id": "synthetic-document", "source_id": "synthetic-source", "snippet_ok": true, "url_ok": true}}})
			return
		}
		calls.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": `{"title":"Synthetic native dispatch","claims":[{"text":"Self-authored runtime evidence","kind":"source_statement","citations":[{"evidence_id":"synthetic-evidence","revision":1}]}]}`}}}, "usage": map[string]any{"total_tokens": 20}})
	}))
	t.Cleanup(upstream.Close)
	gateway := &flow.OpenAICompatGateway{URL: upstream.URL, Model: "synthetic-runtime-model", MicroPer1KTok: 1000, HTTP: upstream.Client()}
	svc.ConfigureFlowModel(gateway)
	engine := flow.EngineClient{Cfg: flow.Config{EngineURL: upstream.URL, SigningKey: []byte("synthetic-runtime-signing-key-32-bytes-minimum"), Issuer: "flow-platform", Audience: "loom-engine", TTL: flow.MaxTokenTTL}}
	tools := flow.Tools{DB: db, Model: gateway, Engine: engine}
	worker := flow.ModelTasks{DB: db, GW: gateway, CanvasExecutions: &executions}
	if worker.DB != worker.CanvasExecutions.DB || tools.DB != executions.DB {
		t.Fatal("model worker and native runner must share the guarded DB")
	}
	input := `[{"material_scope":{"document_ids":["synthetic-document"]},"citations":[{"evidence_id":"synthetic-evidence","revision":1}],"value":"Self-authored runtime evidence"}]`
	doc, _ := json.Marshal(map[string]any{"nodes": []any{
		map[string]any{"id": "input", "type": "data-source", "metadata": map[string]any{"dataSource": map[string]any{"format": "json", "rawText": input}}},
		map[string]any{"id": "skill", "type": "skill", "metadata": map[string]any{"skillId": installed.SkillID, "skillVersion": installed.Version, "skillHash": installed.Hash}},
	}, "connections": []any{map[string]any{"id": "edge", "fromNodeId": "input", "toNodeId": "skill"}}})
	if err = db.Create(&model.CanvasProject{ID: "runtime-native", UserID: "user", Revision: 1, PayloadJSON: string(doc)}).Error; err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 2)
	runner := flow.CanvasWorkflowManagedRunner{Tools: tools, WorkerID: "composition-test", Timeout: 20 * time.Second, NodeBudgetMicro: 100_000, MaxTokens: 4096}
	svc.ConfigureCanvasWorkflowRunner(func(ctx context.Context, e flow.CanvasWorkflowExecutions, run model.CanvasWorkflowExecution) error {
		err := runner.Run(ctx, e, run)
		done <- err
		return err
	})
	approval, err := svc.RequestCanvasWorkflowApproval(context.Background(), "user", "runtime-native", json.RawMessage(`{"expected_revision":1,"ops":[],"run":{"budget_micro":100000}}`))
	if err != nil {
		t.Fatal(err)
	}
	agentID, approvalID := approval["agent_run_id"].(string), approval["approval_id"].(string)
	if err = svc.DecideCloudAgentApproval("user", agentID, approvalID, "approve", "Authorized synthetic runtime test"); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-done:
		if err != nil {
			t.Fatalf("approved native runtime: %v", err)
		}
	case <-time.After(25 * time.Second):
		t.Fatal("native runner did not finish")
	}
	var run model.CanvasWorkflowExecution
	if err = db.First(&run, "canvas_id = ?", "runtime-native").Error; err != nil {
		t.Fatal(err)
	}
	if run.Status != "succeeded" || calls.Load() != 1 {
		t.Fatalf("native runtime did not execute exactly once: %s calls=%d", run.Status, calls.Load())
	}
	var tasks []model.FlowModelTask
	if err = db.Where("tenant_id = ?", scope.TenantID).Find(&tasks).Error; err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 || tasks[0].Status != "succeeded" || tasks[0].CostMicro <= 0 {
		t.Fatalf("native model task: %+v", tasks)
	}
	var parent, child model.FlowBudgetReservation
	if err = db.First(&parent, "id = ?", run.ReservationID).Error; err != nil || parent.Status != "settled" {
		t.Fatalf("native parent reservation was not settled: %s err=%v", parent.Status, err)
	}
	if err = db.First(&child, "id = ? AND parent_id = ?", tasks[0].ReservationID, parent.ID).Error; err != nil || child.Status != "settled" {
		t.Fatalf("native child usage was not settled under its approved parent: %s err=%v", child.Status, err)
	}
	var saved model.CanvasProject
	if err = db.First(&saved, "id = ?", "runtime-native").Error; err != nil || saved.Revision != 2 {
		t.Fatalf("native Canvas write-back: revision=%d err=%v", saved.Revision, err)
	}
}
