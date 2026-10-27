package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"yingce/backend/internal/flow"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

func TestNativeVideoRetentionRuntimeAndWarmReplayCache(t *testing.T) {
	for _, action := range []string{"erased", "revoked"} {
		t.Run(action, func(t *testing.T) {
			s, db, _, _ := creationTestService(t)
			if err := db.AutoMigrate(&model.FlowAgentConversation{}, &model.FlowAgentMessage{}, &model.FlowAgentToolCall{}, &model.FlowEventInbox{}, &model.FlowNotification{}, &model.FlowNotificationDelivery{}, &model.FlowOperationProjection{}, &model.FlowModelTask{}); err != nil {
				t.Fatal(err)
			}
			for _, row := range []any{
				&model.CanvasProject{ID: "user-canvas", UserID: "user", PayloadJSON: `{"nodes":[{"id":"user-drawing","content":"keep my drawing"}]}`},
				&model.CloudAgentCanvasMutation{ID: "undo", UserID: "user", RunID: "root", CanvasID: "user-canvas", Status: "applied", BeforeJSON: `{"nodes":[{"content":"PRIVATE VIDEO"}]}`},
				&model.FlowAgentConversation{ID: "video-conv", UserID: "user", TenantID: "tenant", WorkspaceID: "workspace", SubjectKind: "intelligence", SubjectID: "workspace", EvidenceScope: `{}`},
				&model.CloudAgentExecution{ID: "root", UserID: "user", ConversationID: "root", Status: "running", Revision: 1, StateJSON: `{"request":{"conversationId":"video-conv","prompt":"user-authored"},"canonical":{"messages":[{"role":"assistant","content":"PRIVATE VIDEO"}]}}`},
				&model.Task{ID: "root", UserID: "user", Operation: "cloud_agent", Status: model.TaskStatusTextReplay, InputJSON: `{"cloudAgent":{"request":{"conversationId":"video-conv","prompt":"user-authored"}},"piSessionJSONL":"PRIVATE VIDEO"}`},
				&model.Task{ID: "child", UserID: "user", AgentRunID: "root", Type: "canvas_text", Status: model.TaskStatusRunning, TextDraft: "PRIVATE VIDEO"},
				&model.TaskTextDelta{ID: "delta", UserID: "user", TaskID: "child", Content: "PRIVATE VIDEO", Sequence: 1, ExpiresAt: time.Now().Add(time.Hour)},
				&model.CloudAgentPiSession{RunID: "root", UserID: "user", SessionJSONL: "PRIVATE VIDEO", Revision: 1},
			} {
				if err := db.Create(row).Error; err != nil {
					t.Fatal(err)
				}
			}
			cached, err := s.CachedTaskTextReplay(context.Background(), "user", "child", 0)
			if err != nil || cached.TextDraft != "PRIVATE VIDEO" {
				t.Fatalf("warm cache: %+v %v", cached, err)
			}
			var stale model.CloudAgentExecution
			if err := db.Take(&stale, "id = ?", "root").Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&model.FlowAgentToolCall{ID: "tool", TenantID: "tenant", ConversationID: "video-conv", ToolName: "intel.video_knowledge_search", CallID: "call", Arguments: `{}`, Result: `{"document_id":"document-video"}`, Status: "succeeded"}).Error; err != nil {
				t.Fatal(err)
			}
			s.repo.SetVideoProjectionGuard(flow.CheckVideoConversationProjection)
			payload, _ := json.Marshal(map[string]any{"action": action, "document_ids": []string{"document-video"}})
			if _, err := flow.ConsumeEvent(db, "native-test", flow.Event{EventID: "revoke", OperationID: "retention", TenantID: "tenant", WorkspaceID: "workspace", Type: "knowledge.dependencies_revoked", Sequence: 1, Payload: payload}); err != nil {
				t.Fatal(err)
			}
			checks := map[string]func() error{
				"warm replay":     func() error { _, err := s.CachedTaskTextReplay(context.Background(), "user", "child", 0); return err },
				"native run":      func() error { _, err := s.CloudAgentRun("user", "root"); return err },
				"unchanged SSE":   func() error { _, err := s.CloudAgentRunIfChanged("user", "root", 1); return err },
				"resume Pi":       func() error { return s.runCloudAgentPiSession(context.Background(), "user", "root") },
				"stale scheduler": func() error { return s.advanceCloudAgent(&stale) },
				"late Pi snapshot": func() error {
					_, err := s.handlePiSessionSnapshot("user", "root", map[string]any{"sessionJSONL": "LATE PRIVATE VIDEO"})
					return err
				},
				"late Pi event": func() error {
					_, err := s.cloudAgentPiEvent(context.Background(), "user", "root", map[string]json.RawMessage{"type": json.RawMessage(`"session_snapshot"`), "sessionJSONL": json.RawMessage(`"LATE PRIVATE VIDEO"`)})
					return err
				},
				"late text delta": func() error { _, err := s.AppendTaskTextDelta("user", "child", "LATE PRIVATE VIDEO"); return err },
				"late root admission": func() error {
					return s.repo.CreateTaskWithActiveLimit(&model.Task{ID: "late", UserID: "user", Operation: "cloud_agent", InputJSON: `{"cloudAgent":{"request":{"conversationId":"video-conv"}}}`}, 20)
				},
				"undo Canvas": func() error {
					_, err := s.UndoCloudAgentCanvas("user", "root", "", strings.Repeat("a", 64), "undo")
					return err
				},
				"late undo snapshot": func() error {
					return s.repo.CreateCloudAgentCanvasMutation(&model.CloudAgentCanvasMutation{ID: "late-undo", UserID: "user", RunID: "root", CanvasID: "user-canvas", Status: "applied", BeforeJSON: "LATE PRIVATE VIDEO"})
				},
				"late undo receipt": func() error { return s.repo.MarkCloudAgentCanvasMutationUndone("user", "root", "undo", time.Now()) },
			}
			for name, check := range checks {
				t.Run(name, func(t *testing.T) {
					if err := check(); !errors.Is(err, repository.ErrVideoContentUnavailable) && !errors.Is(err, flow.ErrVideoProjectionUnavailable) && !errors.Is(err, flow.ErrVideoContentErased) {
						t.Fatalf("retention fence not applied: %v", err)
					}
				})
			}
			state := cloudAgentRuntime{Events: []CloudAgentEvent{{Seq: 1, Payload: map[string]any{"text": "PRIVATE VIDEO"}}}}
			if got := s.cloudAgentRunEventsForView("user", &stale, &state, 0, 20); len(got) != 0 {
				t.Fatalf("stale in-memory journal exposed: %+v", got)
			}
			var saved model.CloudAgentPiSession
			db.Take(&saved, "run_id = ?", "root")
			if strings.Contains(saved.SessionJSONL, "LATE") || (action == "erased" && strings.Contains(saved.SessionJSONL, "PRIVATE VIDEO")) {
				t.Fatalf("session retained derived text: %s", saved.SessionJSONL)
			}
			var canvas model.CanvasProject
			if err := db.Take(&canvas, "id = ?", "user-canvas").Error; err != nil {
				t.Fatal(err)
			}
			if canvas.PayloadJSON != `{"nodes":[{"id":"user-drawing","content":"keep my drawing"}]}` {
				t.Fatal("revoked undo changed user Canvas")
			}
			var mutation model.CloudAgentCanvasMutation
			if err := db.Take(&mutation, "id = ?", "undo").Error; err != nil {
				t.Fatal(err)
			}
			if mutation.Status != "not_undoable" || (action == "erased" && mutation.BeforeJSON != "") {
				t.Fatalf("undo receipt not invalidated: %+v", mutation)
			}
		})
	}
}
