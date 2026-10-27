package repository

import (
	"encoding/json"
	"strings"
	"time"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

// PurgeVideoConversationCaches is called only from the authoritative Flow
// revocation transaction. It changes derived cache bodies/control state, never
// billing orders, usage, user messages, or an unrelated workspace's runs.
func PurgeVideoConversationCaches(tx *gorm.DB, tenantID, workspaceID string, conversationIDs []string, erase bool) error {
	if len(conversationIDs) == 0 {
		return nil
	}
	var conversations []model.FlowAgentConversation
	if err := tx.Where("tenant_id = ? AND workspace_id = ? AND id IN ?", tenantID, workspaceID, conversationIDs).Find(&conversations).Error; err != nil {
		return err
	}
	byUser := map[string]map[string]bool{}
	for _, conv := range conversations {
		if byUser[conv.UserID] == nil {
			byUser[conv.UserID] = map[string]bool{}
		}
		byUser[conv.UserID][conv.ID] = true
	}
	for userID, convIDs := range byUser {
		var runs []model.CloudAgentExecution
		if tx.Migrator().HasTable(&model.CloudAgentExecution{}) {
			if err := tx.Where("user_id = ?", userID).Find(&runs).Error; err != nil {
				return err
			}
		}
		var tasks []model.Task
		if tx.Migrator().HasTable(&model.Task{}) {
			if err := tx.Where("user_id = ? AND (operation = ? OR agent_run_id <> '')", userID, "cloud_agent").Find(&tasks).Error; err != nil {
				return err
			}
		}
		selected := map[string]bool{}
		ids := make([]string, 0, len(convIDs))
		for id := range convIDs {
			ids = append(ids, id)
		}
		var linked []string
		if err := tx.Table("flow_agent_messages m").Select("DISTINCT m.run_id").Joins("JOIN flow_agent_conversations c ON c.id = m.conversation_id AND c.tenant_id = m.tenant_id").Where("c.user_id = ? AND c.tenant_id = ? AND c.workspace_id = ? AND c.id IN ? AND m.run_id <> ''", userID, tenantID, workspaceID, ids).Scan(&linked).Error; err != nil {
			return err
		}
		for _, id := range linked {
			selected[id] = true
		}
		for _, run := range runs {
			if convIDs[nativeConversationID(run.StateJSON, false)] {
				selected[run.ID] = true
			}
		}
		for _, task := range tasks {
			if convIDs[nativeConversationID(task.InputJSON, true)] {
				selected[task.ID] = true
			}
		}
		// Continuations inherit native state/session, even when their own Flow
		// user-message mirror has not yet been committed.
		for changed := true; changed; {
			changed = false
			for _, run := range runs {
				if !selected[run.ID] && (selected[run.ParentID] || selected[run.ConversationID]) {
					selected[run.ID] = true
					changed = true
				}
			}
		}
		marker := videoContentRevoked
		if erase {
			marker = videoContentErased
		}
		for _, run := range runs {
			if !selected[run.ID] {
				continue
			}
			fields := map[string]any{"status": "cancelled", "failure_message": marker, "revision": gorm.Expr("revision + 1"), "active_task_id": "", "media_task_id": "", "cleanup_pending": false, "updated_at": time.Now().UTC()}
			if erase {
				fields["state_json"] = nativeRetainedRequest(run.StateJSON, false)
				fields["title"] = "Source content unavailable"
			}
			if err := tx.Model(&model.CloudAgentExecution{}).Where("id = ? AND user_id = ?", run.ID, userID).Updates(fields).Error; err != nil {
				return err
			}
		}
		runIDs := make([]string, 0, len(selected))
		for id := range selected {
			runIDs = append(runIDs, id)
		}
		if len(runIDs) > 0 && tx.Migrator().HasTable(&model.CloudAgentCanvasMutation{}) {
			fields := map[string]any{"status": "not_undoable"}
			if erase {
				fields["before_json"] = ""
			}
			// Undo snapshots are exact run-derived copies, not the live Canvas.
			if err := tx.Model(&model.CloudAgentCanvasMutation{}).Where("user_id = ? AND run_id IN ?", userID, runIDs).Updates(fields).Error; err != nil {
				return err
			}
		}
		if erase && len(runIDs) > 0 {
			if tx.Migrator().HasTable(&model.CloudAgentPiSession{}) {
				var sessions []model.CloudAgentPiSession
				if err := tx.Where("user_id = ? AND run_id IN ?", userID, runIDs).Find(&sessions).Error; err != nil {
					return err
				}
				for _, session := range sessions {
					if err := tx.Model(&model.CloudAgentPiSession{}).Where("user_id = ? AND run_id = ?", userID, session.RunID).Updates(map[string]any{"session_jsonl": nativeRetainedPiUsers(session.SessionJSONL), "revision": gorm.Expr("revision + 1")}).Error; err != nil {
						return err
					}
				}
			}
			if tx.Migrator().HasTable(&model.CloudAgentEventRecord{}) {
				if err := tx.Model(&model.CloudAgentEventRecord{}).Where("user_id = ? AND run_id IN ?", userID, runIDs).Update("event_json", `{"content_erased":true}`).Error; err != nil {
					return err
				}
			}
			if tx.Migrator().HasTable(&model.CloudAgentMessageRecord{}) {
				var messages []model.CloudAgentMessageRecord
				if err := tx.Where("user_id = ? AND run_id IN ?", userID, runIDs).Find(&messages).Error; err != nil {
					return err
				}
				for _, message := range messages {
					if nativeUserMessage(message.MessageJSON) {
						continue
					}
					if err := tx.Model(&model.CloudAgentMessageRecord{}).Where("user_id = ? AND run_id = ? AND kind = ? AND sequence = ?", userID, message.RunID, message.Kind, message.Sequence).Update("message_json", `{"content_erased":true}`).Error; err != nil {
						return err
					}
				}
			}
		}
		for _, task := range tasks {
			if !selected[task.ID] && !selected[task.AgentRunID] {
				continue
			}
			fields := map[string]any{"status": model.TaskStatusCancelled, "error": marker, "lease_owner": "", "lease_expires_at": nil, "updated_at": time.Now().UTC()}
			if erase {
				fields["result_json"], fields["text_draft"], fields["execution_diagnostic_json"], fields["media_recovery_json"] = "", "", "", ""
				fields["input_json"] = nativeRetainedRequest(task.InputJSON, true)
				if task.AgentRunID != "" && task.AgentRunID != task.ID {
					fields["prompt"] = ""
				}
			}
			if err := tx.Model(&model.Task{}).Where("user_id = ? AND id = ?", userID, task.ID).Updates(fields).Error; err != nil {
				return err
			}
			if erase {
				if tx.Migrator().HasTable(&model.TaskTextDelta{}) {
					if err := tx.Where("user_id = ? AND task_id = ?", userID, task.ID).Delete(&model.TaskTextDelta{}).Error; err != nil {
						return err
					}
				}
				if tx.Migrator().HasTable(&model.Result{}) {
					if err := tx.Model(&model.Result{}).Where("user_id = ? AND task_id = ?", userID, task.ID).Updates(map[string]any{"payload": "", "url": ""}).Error; err != nil {
						return err
					}
				}
				if tx.Migrator().HasTable(&model.TaskLog{}) {
					if err := tx.Model(&model.TaskLog{}).Where("user_id = ? AND task_id = ?", userID, task.ID).Updates(map[string]any{"payload": "", "message": marker}).Error; err != nil {
						return err
					}
				}
			}
		}
	}
	return nil
}

func nativeRetainedRequest(raw string, task bool) string {
	var value map[string]any
	_ = json.Unmarshal([]byte(raw), &value)
	source := value
	if task {
		source, _ = value["cloudAgent"].(map[string]any)
	}
	request, _ := source["request"].(map[string]any)
	kept := map[string]any{}
	for _, key := range []string{"conversationId", "prompt", "canvasId", "idempotencyKey"} {
		if v, ok := request[key]; ok {
			kept[key] = v
		}
	}
	out := map[string]any{"request": kept, "_video_content_erased": true}
	if users := nativeRetainedUsers(source["textHistory"]); len(users) > 0 {
		out["textHistory"] = users
	}
	if canonical, ok := source["canonical"].(map[string]any); ok {
		if users := nativeRetainedUsers(canonical["messages"]); len(users) > 0 {
			out["canonical"] = map[string]any{"messages": users}
		}
	}
	if task {
		out = map[string]any{"cloudAgent": out, "_video_content_erased": true}
		if users := nativeRetainedUsers(value["textHistory"]); len(users) > 0 {
			out["textHistory"] = users
		}
		if requests, ok := value["agentRequests"].(map[string]any); ok {
			if canonical, ok := requests["canonical"].(map[string]any); ok {
				if users := nativeRetainedUsers(canonical["messages"]); len(users) > 0 {
					out["agentRequests"] = map[string]any{"canonical": map[string]any{"messages": users}}
				}
			}
		}
		if raw, ok := value["piSessionJSONL"].(string); ok {
			out["piSessionJSONL"] = nativeRetainedPiUsers(raw)
		}
	}
	b, _ := json.Marshal(out)
	return string(b)
}

func nativeRetainedUsers(value any) []any {
	var kept []any
	messages, _ := value.([]any)
	for _, message := range messages {
		raw, err := json.Marshal(message)
		if err == nil && nativeUserMessage(string(raw)) {
			kept = append(kept, message)
		}
	}
	return kept
}

func nativeRetainedPiUsers(raw string) string {
	var kept []string
	for _, line := range strings.Split(raw, "\n") {
		var entry map[string]json.RawMessage
		if json.Unmarshal([]byte(line), &entry) != nil || !nativeUserMessage(string(entry["message"])) {
			continue
		}
		// Session extension/compaction/custom fields can carry derived content;
		// preserve only the explicitly user-authored message and stable IDs.
		out := map[string]json.RawMessage{}
		for _, key := range []string{"id", "parentId", "type", "timestamp", "message"} {
			if v, ok := entry[key]; ok {
				out[key] = v
			}
		}
		b, _ := json.Marshal(out)
		kept = append(kept, string(b))
	}
	return strings.Join(kept, "\n")
}
