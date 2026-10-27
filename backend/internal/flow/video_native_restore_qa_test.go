package flow

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

// Typed persisted-cache fixtures, not a claim of real model execution. The
// authoritative deletion and old physical SQLite restore use the real stack.
type videoQANativeCaches struct{ root, child, unrelated, foreign string }

func seedVideoQANativeRestoreCaches(t *testing.T, db *gorm.DB, conv model.FlowAgentConversation) videoQANativeCaches {
	t.Helper()
	videoProjectionPurger.RLock()
	previous := videoProjectionPurger.fn
	videoProjectionPurger.RUnlock()
	RegisterVideoProjectionPurger(repository.PurgeVideoConversationCaches)
	t.Cleanup(func() { RegisterVideoProjectionPurger(previous) })
	f := videoQANativeCaches{"qa-native-root", "qa-native-child", "qa-native-unrelated", "qa-native-foreign"}
	for _, id := range []string{f.root, f.child, f.unrelated, f.foreign} {
		user, parent, group, flowID := "u_alice", "", id, ""
		if id == f.foreign {
			user = "u_bob"
		}
		if id == f.root {
			flowID = conv.ID
		}
		if id == f.child {
			parent, group = f.root, f.root
		}
		state, _ := json.Marshal(map[string]any{"request": map[string]any{"conversationId": flowID, "prompt": "Keep native user question"}, "private": "PRIVATE_HOST_RESTORE_CANARY"})
		input, _ := json.Marshal(map[string]any{"cloudAgent": json.RawMessage(state), "piSessionJSONL": "PRIVATE_HOST_RESTORE_CANARY", "agentRequests": map[string]any{"canonical": "PRIVATE_HOST_RESTORE_CANARY"}})
		rows := []any{
			&model.CloudAgentExecution{ID: id, UserID: user, ParentID: parent, ConversationID: group, Status: "completed", StateJSON: string(state), Title: "PRIVATE_HOST_RESTORE_CANARY", EventCount: 1, MessageCount: 2, Revision: 1},
			&model.CloudAgentPiSession{RunID: id, UserID: user, SessionJSONL: `{"role":"assistant","content":"PRIVATE_HOST_RESTORE_CANARY"}`, Revision: 1},
			&model.CloudAgentEventRecord{RunID: id, UserID: user, Sequence: 1, EventJSON: `{"text":"PRIVATE_HOST_RESTORE_CANARY"}`},
			&model.CloudAgentMessageRecord{RunID: id, UserID: user, Kind: "canonical", Sequence: 1, MessageJSON: `{"role":"user","content":"Keep native user question"}`},
			&model.CloudAgentMessageRecord{RunID: id, UserID: user, Kind: "canonical", Sequence: 2, MessageJSON: `{"role":"assistant","content":"PRIVATE_HOST_RESTORE_CANARY"}`},
			&model.Task{ID: id, UserID: user, AgentRunID: parent, Type: "text", Operation: "cloud_agent", Status: model.TaskStatusSucceeded, InputJSON: string(input), ResultJSON: `{"text":"PRIVATE_HOST_RESTORE_CANARY"}`, TextDraft: "PRIVATE_HOST_RESTORE_CANARY", BillingOrderID: "qa-financial-fact", AuthorizedChargeMicrocredits: 42},
			&model.TaskTextDelta{ID: "delta-" + id, UserID: user, TaskID: id, Sequence: 1, Content: "PRIVATE_HOST_RESTORE_CANARY", ExpiresAt: time.Now().Add(time.Hour)},
			&model.CloudAgentCanvasMutation{ID: "mutation-" + id, RunID: id, UserID: user, CanvasID: "qa-canvas", Operation: "update_node", BeforeJSON: `{"text":"PRIVATE_HOST_RESTORE_CANARY"}`, BeforeSnapshotHash: strings.Repeat("a", 64), AfterSnapshotHash: strings.Repeat("b", 64), Status: "applied"},
		}
		for _, row := range rows {
			if err := db.Create(row).Error; err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := (Conversations{DB: db}).Append(conv, model.FlowAgentMessage{Role: "assistant", RunID: f.root, Content: "PRIVATE_HOST_RESTORE_CANARY native derived answer"}); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f videoQANativeCaches) repository(db *gorm.DB) *repository.Repository {
	r := repository.New(db)
	r.SetVideoProjectionGuard(func(ctx context.Context, scoped *gorm.DB, user, conv string) error {
		return CheckVideoConversationProjection(ctx, scoped, user, conv)
	})
	return r
}

func (f videoQANativeCaches) assertOldBackup(t *testing.T, db *gorm.DB) {
	t.Helper()
	for _, id := range []string{f.root, f.child} {
		var run model.CloudAgentExecution
		if err := db.First(&run, "id = ?", id).Error; err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(run.StateJSON, "PRIVATE_HOST_RESTORE_CANARY") {
			t.Fatal("native negative-control snapshot was not before erasure")
		}
	}
}

func (f videoQANativeCaches) assertBlocked(t *testing.T, db *gorm.DB) {
	t.Helper()
	r := f.repository(db)
	for _, id := range []string{f.root, f.child} {
		if _, err := r.CloudAgent("u_alice", id); err == nil {
			t.Fatalf("native execution read escaped barrier: %s", id)
		}
		if _, err := r.CloudAgentPiSession("u_alice", id); err == nil {
			t.Fatalf("native Pi session escaped barrier: %s", id)
		}
		if _, err := r.CloudAgentEventRecords("u_alice", id, 0, 10); err == nil {
			t.Fatalf("native event replay escaped barrier: %s", id)
		}
		if _, err := r.TaskForUser("u_alice", id); err == nil {
			t.Fatalf("native task fallback escaped barrier: %s", id)
		}
		if _, err := r.TaskTextDeltas("u_alice", id, 0, 10); err == nil {
			t.Fatalf("native SSE replay escaped barrier: %s", id)
		}
		if _, err := r.LatestCloudAgentCanvasMutation("u_alice", id); err == nil {
			t.Fatalf("native undo snapshot escaped barrier: %s", id)
		}
	}
	if _, err := r.CloudAgent("u_alice", f.unrelated); err != nil {
		t.Fatalf("unrelated native run unavailable: %v", err)
	}
}

func (f videoQANativeCaches) assertErased(t *testing.T, db *gorm.DB) {
	t.Helper()
	f.assertBlocked(t, db)
	for _, id := range []string{f.root, f.child} {
		var run model.CloudAgentExecution
		var task model.Task
		var sessions []model.CloudAgentPiSession
		var events []model.CloudAgentEventRecord
		var messages []model.CloudAgentMessageRecord
		var deltas []model.TaskTextDelta
		var mutations []model.CloudAgentCanvasMutation
		for _, result := range []*gorm.DB{
			db.First(&run, "id = ?", id), db.First(&task, "id = ?", id), db.Find(&sessions, "run_id = ?", id),
			db.Find(&events, "run_id = ?", id), db.Find(&messages, "run_id = ?", id), db.Find(&deltas, "task_id = ?", id),
			db.Find(&mutations, "run_id = ?", id),
		} {
			if result.Error != nil {
				t.Fatal(result.Error)
			}
		}
		mutationContent := ""
		for _, mutation := range mutations {
			mutationContent += mutation.BeforeJSON
		}
		raw, _ := json.Marshal([]any{run, task, sessions, events, messages, deltas, mutationContent})
		if strings.Contains(string(raw), "PRIVATE_HOST_RESTORE_CANARY") {
			t.Fatalf("native persisted cache survived erasure: %s", id)
		}
		if task.BillingOrderID != "qa-financial-fact" || task.AuthorizedChargeMicrocredits != 42 {
			t.Fatal("native cache erasure removed financial facts")
		}
		messageJSON, _ := json.Marshal(messages)
		if !strings.Contains(string(messageJSON), "Keep native user question") {
			t.Fatal("native erasure lost user-authored canonical message")
		}
		late := model.CloudAgentPiSession{RunID: id, UserID: "u_alice", Revision: 1, SessionJSONL: "PRIVATE_HOST_RESTORE_CANARY late process"}
		if err := f.repository(db).SaveCloudAgentPiSession(&late, 1); err == nil {
			t.Fatal("late native process resurrected erased Pi session")
		}
	}
	for _, id := range []string{f.unrelated, f.foreign} {
		var run model.CloudAgentExecution
		if err := db.First(&run, "id = ?", id).Error; err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(run.StateJSON, "PRIVATE_HOST_RESTORE_CANARY") {
			t.Fatal("unrelated or foreign native cache was scrubbed")
		}
	}
}
