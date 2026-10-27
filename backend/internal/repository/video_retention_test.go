package repository

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

func nativeRetentionFixture(t *testing.T) (*Repository, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:%s?mode=memory&cache=shared", t.Name())), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err = db.AutoMigrate(&model.FlowAgentConversation{}, &model.FlowAgentMessage{}, &model.CloudAgentExecution{}, &model.CloudAgentPiSession{}, &model.CloudAgentEventRecord{}, &model.CloudAgentMessageRecord{}, &model.Task{}, &model.TaskTextDelta{}); err != nil {
		t.Fatal(err)
	}
	for _, row := range []any{
		&model.FlowAgentConversation{ID: "flow-video", TenantID: "tenant", WorkspaceID: "workspace", UserID: "user", EvidenceScope: `{"_video_content_erased":true}`},
		&model.CloudAgentExecution{ID: "native-root", UserID: "user", ConversationID: "native-root", Status: "running", Revision: 1, StateJSON: `{"request":{"conversationId":"flow-video","prompt":"user-authored"},"canonical":{"content":"SECRET"}}`},
		&model.CloudAgentPiSession{RunID: "native-root", UserID: "user", Revision: 1, SessionJSONL: "SECRET"},
		&model.CloudAgentEventRecord{RunID: "native-root", UserID: "user", Sequence: 1, EventJSON: `{"text":"SECRET"}`},
		&model.Task{ID: "native-root", UserID: "user", Operation: "cloud_agent", Status: model.TaskStatusTextReplay, InputJSON: `{"cloudAgent":{"request":{"conversationId":"flow-video","prompt":"user-authored"}},"agentRequests":{"canonical":{"content":"SECRET"}},"piSessionJSONL":"SECRET"}`},
		&model.Task{ID: "child", UserID: "user", AgentRunID: "native-root", Status: model.TaskStatusRunning, ResultJSON: `{"text":"SECRET"}`, TextDraft: "SECRET"},
		&model.TaskTextDelta{ID: "delta", UserID: "user", TaskID: "child", Sequence: 1, Content: "SECRET", ExpiresAt: time.Now().Add(time.Hour)},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	return New(db), db
}

func TestNativeVideoRetentionPurgeExactLinksAndPreserveUsers(t *testing.T) {
	_, db := nativeRetentionFixture(t)
	for _, row := range []any{
		&model.CloudAgentExecution{ID: "descendant", UserID: "user", ParentID: "native-root", ConversationID: "native-root", StateJSON: `{"request":{"prompt":"another user turn"},"canonical":"SECRET"}`, FailureMessage: "SECRET"},
		&model.CloudAgentExecution{ID: "message-linked", UserID: "user", ConversationID: "message-linked", StateJSON: `{"canonical":"SECRET"}`},
		&model.FlowAgentMessage{ID: "link", TenantID: "tenant", ConversationID: "flow-video", RunID: "message-linked", Seq: 1, Role: "user", Content: "authored user message"},
		&model.CloudAgentMessageRecord{RunID: "native-root", UserID: "user", Kind: "canonical", Sequence: 1, MessageJSON: `{"role":"user","content":"authored user message"}`},
		&model.CloudAgentMessageRecord{RunID: "native-root", UserID: "user", Kind: "canonical", Sequence: 2, MessageJSON: `{"role":"user","agentContextSource":"flow_context","content":"SECRET"}`},
		&model.CloudAgentMessageRecord{RunID: "native-root", UserID: "user", Kind: "canonical", Sequence: 3, MessageJSON: `{"role":"assistant","content":"SECRET"}`},
		&model.FlowAgentConversation{ID: "other-workspace", TenantID: "tenant", WorkspaceID: "other", UserID: "user"},
		&model.CloudAgentExecution{ID: "unrelated", UserID: "user", ConversationID: "unrelated", StateJSON: `{"request":{"conversationId":"other-workspace","prompt":"user mentioned flow-video"},"canonical":"KEEP"}`},
		&model.Task{ID: "unrelated", UserID: "user", Operation: "cloud_agent", InputJSON: `{"cloudAgent":{"request":{"conversationId":"other-workspace"}}}`, ResultJSON: "KEEP"},
		&model.Task{ID: "legacy-only", UserID: "user", Operation: "cloud_agent", InputJSON: `{"cloudAgent":{"request":{"conversationId":"flow-video","prompt":"legacy user"}},"piSessionJSONL":"SECRET"}`},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Model(&model.CloudAgentPiSession{}).Where("run_id = ?", "native-root").Update("session_jsonl", `{"type":"message","message":{"role":"user","content":"authored user message"}}`+"\n"+`{"type":"compaction","summary":"SECRET"}`+"\n"+`{"type":"message","message":{"role":"assistant","content":"SECRET"}}`).Error; err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := db.Transaction(func(tx *gorm.DB) error {
			return PurgeVideoConversationCaches(tx, "tenant", "workspace", []string{"flow-video"}, true)
		}); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{"native-root", "descendant", "message-linked"} {
		var run model.CloudAgentExecution
		if err := db.Take(&run, "id = ?", id).Error; err != nil {
			t.Fatal(err)
		}
		if strings.Contains(run.StateJSON, "SECRET") || run.Status != "cancelled" || run.FailureMessage != videoContentErased {
			t.Fatalf("native cache not purged: %+v", run)
		}
	}
	var session model.CloudAgentPiSession
	db.Take(&session, "run_id = ?", "native-root")
	if strings.Contains(session.SessionJSONL, "SECRET") || !strings.Contains(session.SessionJSONL, "authored user message") {
		t.Fatalf("session scrub: %s", session.SessionJSONL)
	}
	var messages []model.CloudAgentMessageRecord
	db.Find(&messages)
	for _, message := range messages {
		if strings.Contains(message.MessageJSON, "SECRET") {
			t.Fatalf("transcript leaked: %s", message.MessageJSON)
		}
	}
	if !strings.Contains(messages[0].MessageJSON, "authored user message") {
		t.Fatal("user-authored transcript was erased")
	}
	for _, id := range []string{"native-root", "child", "legacy-only"} {
		var task model.Task
		db.Take(&task, "id = ?", id)
		if strings.Contains(task.InputJSON+task.ResultJSON+task.TextDraft, "SECRET") {
			t.Fatalf("task cache leaked: %+v", task)
		}
	}
	var unrelated model.CloudAgentExecution
	db.Take(&unrelated, "id = ?", "unrelated")
	if !strings.Contains(unrelated.StateJSON, "KEEP") {
		t.Fatal("unrelated workspace run was scrubbed")
	}
	var n int64
	db.Model(&model.TaskTextDelta{}).Count(&n)
	if n != 0 {
		t.Fatal("stream delta survived erasure")
	}
}

func TestNativeVideoRetentionFreshBarrierScopesUnknownProjection(t *testing.T) {
	r, db := nativeRetentionFixture(t)
	if err := db.Model(&model.FlowAgentConversation{}).Where("id = ?", "flow-video").Update("evidence_scope", "{}").Error; err != nil {
		t.Fatal(err)
	}
	unavailable := errors.New("authoritative projection unavailable")
	calls := 0
	r.SetVideoProjectionGuard(func(ctx context.Context, db *gorm.DB, userID, convID string) error {
		calls++
		if userID != "user" || convID != "flow-video" {
			t.Fatalf("bad scope %s/%s", userID, convID)
		}
		return unavailable
	})
	if _, err := r.CloudAgentPiSession("user", "native-root"); !errors.Is(err, unavailable) {
		t.Fatalf("restored session escaped fresh barrier: %v", err)
	}
	if _, err := r.TaskForUser("user", "child"); !errors.Is(err, unavailable) {
		t.Fatalf("restored child result escaped fresh barrier: %v", err)
	}
	if err := db.Create(&model.Task{ID: "ordinary", UserID: "user", ResultJSON: "RSS"}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := r.TaskForUser("user", "ordinary"); err != nil {
		t.Fatalf("unrelated task blocked: %v", err)
	}
	if calls != 2 {
		t.Fatalf("authoritative callback count = %d", calls)
	}
}

func TestNativeVideoRetentionRemovesExplicitDerivedUserContext(t *testing.T) {
	for _, raw := range []string{
		`{"role":"user","agentContextSource":"flow_context","content":"PRIVATE"}`,
		`{"role":"user","content":[{"type":"text","text":"本轮情报工作区上下文（服务端组装的数据 PRIVATE"}]}`,
		`{"role":"user","content":"The conversation history before this point was compacted into the following summary: PRIVATE"}`,
	} {
		if nativeUserMessage(raw) {
			t.Fatalf("derived user-role context retained: %s", raw)
		}
	}
	if !nativeUserMessage(`{"role":"user","agentContextSource":"user_interjection","content":"authored user turn"}`) {
		t.Fatal("user-authored interjection erased")
	}
}

func TestNativeVideoRetentionFencesRestoredReadsAndLateWrites(t *testing.T) {
	r, _ := nativeRetentionFixture(t)
	checks := map[string]func() error{
		"execution":     func() error { _, err := r.CloudAgent("user", "native-root"); return err },
		"session":       func() error { _, err := r.CloudAgentPiSession("user", "native-root"); return err },
		"journal":       func() error { _, err := r.CloudAgentEventRecords("user", "native-root", 0, 20); return err },
		"legacy task":   func() error { _, err := r.TaskForUser("user", "native-root"); return err },
		"child result":  func() error { _, err := r.TaskForUser("user", "child"); return err },
		"stream replay": func() error { _, err := r.TaskTextDeltas("user", "child", 0, 20); return err },
		"late session": func() error {
			return r.SaveCloudAgentPiSession(&model.CloudAgentPiSession{RunID: "native-root", UserID: "user", SessionJSONL: "LATE SECRET"}, 1)
		},
		"late stream": func() error {
			_, err := r.AppendTaskTextDelta("user", "child", "LATE SECRET", time.Now().Add(time.Hour), TextReplayLimits{MaxTaskBytes: 10000, MaxUserBytes: 10000, MaxTaskEvents: 100})
			return err
		},
	}
	for name, check := range checks {
		t.Run(name, func(t *testing.T) {
			if err := check(); err == nil {
				t.Fatal("revoked video cache remained readable/writable")
			}
		})
	}
}
