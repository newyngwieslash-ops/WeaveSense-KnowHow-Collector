package flow

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"yingce/backend/internal/model"
)

func TestVideoErasePurgesScopedModelAndToolCachesWithoutLosingUsage(t *testing.T) {
	tools, _, conv, ss := setupP3(t)
	context := func(workspace string) string {
		raw, _ := json.Marshal(videoModelContext{WorkspaceID: workspace, JobID: "job-erased", InputHash: "audit-hash", Frames: []VideoModelFrame{{ObjectKey: "controlled/object"}}})
		return string(raw)
	}
	for _, task := range []model.FlowModelTask{
		{ID: "erase-task", TenantID: ss.Scope.TenantID, IdemKey: "erase-task", Purpose: "video_summary", Status: "succeeded", Request: `{"user":"private source text"}`, Result: `{"summary":"private result"}`, Context: context(ss.Scope.WorkspaceID), CostMicro: 42},
		{ID: "foreign-task", TenantID: ss.Scope.TenantID, IdemKey: "foreign-task", Purpose: "video_summary", Status: "succeeded", Request: `{"user":"private other workspace"}`, Result: `{"summary":"keep"}`, Context: context("foreign-workspace"), CostMicro: 43},
	} {
		if err := tools.DB.Create(&task).Error; err != nil {
			t.Fatal(err)
		}
	}
	call := model.FlowAgentToolCall{ID: "erase-call", TenantID: ss.Scope.TenantID, ConversationID: conv.ID, CallID: "call", ToolName: "intel_read_document", Class: "read", RequestHash: "audit-request-hash", Arguments: `{"document_id":"doc-erased"}`, Status: "succeeded", Result: `{"output":{"text":"private source text","document_id":"doc-erased"}}`}
	if err := tools.DB.Create(&call).Error; err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]any{"action": "erased", "document_ids": []string{"doc-erased"}, "video_job_ids": []string{"job-erased"}})
	event := Event{EventID: "erase-event", OperationID: "erase-operation", TenantID: ss.Scope.TenantID, WorkspaceID: ss.Scope.WorkspaceID, Type: "knowledge.dependencies_revoked", Payload: payload, OccurredAt: time.Now(), Sequence: 1}
	if ok, err := ConsumeEvent(tools.DB, "platform-projection", event); err != nil || !ok {
		t.Fatalf("erase intake %v %v", ok, err)
	}
	if ok, err := ConsumeEvent(tools.DB, "platform-projection", event); err != nil || ok {
		t.Fatalf("erase replay %v %v", ok, err)
	}
	// A call already in flight may settle after erasure; financial facts survive,
	// but neither its response nor its cleared error can resurrect source text.
	(ModelTasks{DB: tools.DB}).set("erase-task", map[string]any{"status": "succeeded", "result": "late private output", "cost_micro": 45, "last_error": ""})
	var erased, foreign model.FlowModelTask
	tools.DB.First(&erased, "id = ?", "erase-task")
	tools.DB.First(&foreign, "id = ?", "foreign-task")
	if erased.Request != "" || erased.Result != "" || erased.LastError != videoContentErased || erased.CostMicro != 45 || foreign.Result == "" {
		t.Fatalf("erasure/race/scope drift: erased=%+v foreign=%+v", erased, foreign)
	}
	var meta videoModelContext
	_ = json.Unmarshal([]byte(erased.Context), &meta)
	if len(meta.Frames) != 0 || meta.InputHash != "audit-hash" {
		t.Fatal("lost audit hash or retained frame reference")
	}
	tools.DB.First(&call, "id = ?", call.ID)
	if call.Status != "failed" || call.Arguments != "{}" || call.Result == "" || containsVideoReference(call.Result, map[string]bool{"doc-erased": true}) {
		t.Fatal("cached tool material still accessible")
	}
	if _, err := ModelTaskOperation(tools.DB, ss.Scope.TenantID, "erase-task"); err == nil {
		t.Fatal("generic synthesis endpoint exposed a video task")
	}
}

func TestVideoEraseDerivedPresentationsAndLateEvents(t *testing.T) {
	tools, _, conv, ss := setupP3(t)
	event := func(id, kind, workspace string, payload any) Event {
		return Event{EventID: id, OperationID: "op-" + id, TenantID: ss.Scope.TenantID, WorkspaceID: workspace, Type: kind, Payload: mustJSON(payload), OccurredAt: time.Now(), Sequence: 1}
	}
	for _, e := range []Event{
		event("derived-report", "report.completed", ss.Scope.WorkspaceID, map[string]any{"report_id": "report-erased", "title": "private report title"}),
		event("derived-research", "research.completed", ss.Scope.WorkspaceID, map[string]any{"research_run_id": "research-erased", "reason": "private research reason"}),
		event("foreign-derived", "report.completed", "foreign-workspace", map[string]any{"report_id": "report-erased", "title": "foreign private title"}),
	} {
		if _, err := ConsumeEvent(tools.DB, "platform", e); err != nil {
			t.Fatal(err)
		}
	}
	call := model.FlowAgentToolCall{ID: "erase-report-call", TenantID: ss.Scope.TenantID, ConversationID: conv.ID, CallID: "report-call", ToolName: "intel_read_report", Class: "read", RequestHash: "audit", Arguments: `{"report_id":"report-erased"}`, Status: "succeeded", Result: `{"text":"private derived report"}`}
	if err := tools.DB.Create(&call).Error; err != nil {
		t.Fatal(err)
	}
	delivery := model.FlowNotificationDelivery{ID: "erase-delivery", TenantID: ss.Scope.TenantID, WorkspaceID: ss.Scope.WorkspaceID, EventID: "derived-report", TargetID: "fixture-target", Title: "private report title", RefID: "report-erased", Status: "pending"}
	if err := tools.DB.Create(&delivery).Error; err != nil {
		t.Fatal(err)
	}
	erase := event("derived-erase", "knowledge.dependencies_revoked", ss.Scope.WorkspaceID, map[string]any{"action": "erased", "report_ids": []string{"report-erased"}, "research_run_ids": []string{"research-erased"}})
	if _, err := ConsumeEvent(tools.DB, "platform", erase); err != nil {
		t.Fatal(err)
	}
	var notices []model.FlowNotification
	tools.DB.Find(&notices)
	for _, notice := range notices {
		if notice.WorkspaceID == ss.Scope.WorkspaceID && strings.Contains(notice.Title, "private") {
			t.Fatal("derived notification content survived")
		}
		if notice.WorkspaceID == "foreign-workspace" && notice.Title != "foreign private title" {
			t.Fatal("foreign workspace was scrubbed")
		}
	}
	tools.DB.First(&delivery, "id = ?", delivery.ID)
	if delivery.Title != "" || delivery.Status != "cancelled" {
		t.Fatalf("pending external delivery still sends erased content: %+v", delivery)
	}
	tools.DB.First(&call, "id = ?", call.ID)
	if call.Arguments != "{}" || strings.Contains(call.Result, "private") {
		t.Fatal("report-id-only cache survived erasure")
	}
	if result, err := tools.finish(call, ToolResult{CallID: call.CallID, Tool: call.ToolName, Status: "succeeded", Output: json.RawMessage(`{"text":"private late response"}`)}, nil); err != nil || result.Status != "failed" || len(result.Output) != 0 {
		t.Fatalf("late tool response resurrected erased content: %+v %v", result, err)
	}
	late := event("late-derived-report", "report.completed", ss.Scope.WorkspaceID, map[string]any{"report_id": "report-erased", "title": "private late report"})
	if applied, err := ConsumeEvent(tools.DB, "platform", late); err != nil || !applied {
		t.Fatalf("late event intake: %v %v", applied, err)
	}
	var count int64
	tools.DB.Model(&model.FlowNotification{}).Where("event_id = ?", late.EventID).Count(&count)
	if count != 0 {
		t.Fatal("late event resurrected notification")
	}
	var inbox []model.FlowEventInbox
	tools.DB.Where("event_id IN ?", []string{"derived-report", "derived-research", "late-derived-report"}).Find(&inbox)
	if len(inbox) != 3 {
		t.Fatal("dedup/audit envelope lost")
	}
	for _, row := range inbox {
		if strings.Contains(row.Payload, "private") || !strings.Contains(row.Payload, `"content_erased":true`) {
			t.Fatalf("inbox presentation survived: %+v", row)
		}
	}
}
