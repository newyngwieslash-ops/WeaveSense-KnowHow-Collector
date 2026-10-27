package flow

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

const videoContentErased = "video_content_erased"

var videoProjectionPurger struct {
	sync.RWMutex
	fn func(*gorm.DB, string, string, []string, bool) error
}

// RegisterVideoProjectionPurger connects the native runtime's derived stores
// at the application composition root without importing app or repository here.
func RegisterVideoProjectionPurger(fn func(*gorm.DB, string, string, []string, bool) error) {
	videoProjectionPurger.Lock()
	defer videoProjectionPurger.Unlock()
	videoProjectionPurger.fn = fn
}

type videoRevocationPayload struct {
	Action      string   `json:"action"`
	Documents   []string `json:"document_ids"`
	Evidence    []string `json:"evidence_ids"`
	Knowledge   []string `json:"knowledge_ids"`
	Jobs        []string `json:"video_job_ids"`
	Extractions []string `json:"extraction_run_ids"`
	Candidates  []string `json:"skill_candidate_ids"`
	Reports     []string `json:"report_ids"`
	Research    []string `json:"research_run_ids"`
	WorkspaceID string   `json:"_host_workspace_id"`
}

func (p videoRevocationPayload) references() map[string]bool {
	refs := map[string]bool{}
	for _, list := range [][]string{p.Documents, p.Evidence, p.Knowledge, p.Jobs, p.Extractions, p.Candidates, p.Reports, p.Research} {
		for _, id := range list {
			if id != "" {
				refs[id] = true
			}
		}
	}
	return refs
}

// Durable inbox tombstones also fence late/replayed presentation events.
// No source content is needed to retain this suppression boundary.
func videoEventContentErased(tx *gorm.DB, event Event) (bool, error) {
	if event.Type != "report.completed" && event.Type != "research.completed" && event.Type != "document.revised" {
		return false, nil
	}
	var tombstones []model.FlowEventInbox
	if err := tx.Where("tenant_id = ? AND type = ?", event.TenantID, "knowledge.dependencies_revoked").Find(&tombstones).Error; err != nil {
		return false, err
	}
	for _, row := range tombstones {
		var p videoRevocationPayload
		if json.Unmarshal([]byte(row.Payload), &p) == nil && p.WorkspaceID == event.WorkspaceID && (p.Action == "erased" || p.Action == "revoked") && containsVideoReference(string(event.Payload), p.references()) {
			return true, nil
		}
	}
	return false, nil
}

// Runs in the same inbox transaction as the authoritative Loom tombstone.
// Only exact IDs in the signed tenant/workspace envelope select cached content.
func purgeVideoCaches(tx *gorm.DB, event Event) error {
	var payload videoRevocationPayload
	if event.WorkspaceID == "" || json.Unmarshal(event.Payload, &payload) != nil || (payload.Action != "erased" && payload.Action != "revoked") {
		return errors.New("flow: invalid video revocation event")
	}
	refs, jobs := payload.references(), map[string]bool{}
	for _, list := range [][]string{payload.Documents, payload.Evidence, payload.Knowledge, payload.Jobs, payload.Extractions, payload.Candidates, payload.Reports, payload.Research} {
		if len(list) > 10000 {
			return ErrInvalid
		}
	}
	for _, list := range [][]string{payload.Jobs, payload.Extractions, payload.Candidates} {
		for _, id := range list {
			jobs[id] = true
		}
	}
	{
		ids := make([]string, 0, len(refs))
		for id := range refs {
			ids = append(ids, id)
		}
		var notices []model.FlowNotification
		if err := tx.Where("tenant_id = ? AND workspace_id = ? AND ref_id IN ?", event.TenantID, event.WorkspaceID, ids).Find(&notices).Error; err != nil {
			return err
		}
		events := map[string]bool{}
		for _, notice := range notices {
			events[notice.EventID] = true
		}
		if err := tx.Model(&model.FlowNotification{}).Where("tenant_id = ? AND workspace_id = ? AND ref_id IN ?", event.TenantID, event.WorkspaceID, ids).Update("title", "source content unavailable").Error; err != nil {
			return err
		}
		if err := tx.Model(&model.FlowNotificationDelivery{}).Where("tenant_id = ? AND workspace_id = ? AND ref_id IN ?", event.TenantID, event.WorkspaceID, ids).Updates(map[string]any{"title": "", "last_error": videoContentErased, "status": gorm.Expr("CASE WHEN status = 'delivered' THEN status ELSE 'cancelled' END")}).Error; err != nil {
			return err
		}
		var projections []model.FlowOperationProjection
		if err := tx.Where("tenant_id = ? AND workspace_id = ?", event.TenantID, event.WorkspaceID).Find(&projections).Error; err != nil {
			return err
		}
		operations := map[string]bool{}
		for _, projection := range projections {
			operations[projection.OperationID] = true
		}
		var inbox []model.FlowEventInbox
		if err := tx.Where("tenant_id = ? AND type <> ?", event.TenantID, "knowledge.dependencies_revoked").Find(&inbox).Error; err != nil {
			return err
		}
		for _, row := range inbox {
			var meta struct {
				WorkspaceID string `json:"_host_workspace_id"`
			}
			_ = json.Unmarshal([]byte(row.Payload), &meta)
			if (meta.WorkspaceID != event.WorkspaceID && !events[row.EventID] && !operations[row.OperationID]) || !containsVideoReference(row.Payload, refs) {
				continue
			}
			redacted, _ := json.Marshal(map[string]any{"content_erased": true, "video_derived": true, "_host_workspace_id": event.WorkspaceID})
			if err := tx.Model(&model.FlowEventInbox{}).Where("consumer_id = ? AND event_id = ? AND tenant_id = ?", row.ConsumerID, row.EventID, event.TenantID).Update("payload", string(redacted)).Error; err != nil {
				return err
			}
		}
	}
	if payload.Action == "erased" {
		var tasks []model.FlowModelTask
		if err := tx.Where("tenant_id = ?", event.TenantID).Find(&tasks).Error; err != nil {
			return err
		}
		for _, task := range tasks {
			var meta videoModelContext
			var generic map[string]any
			_ = json.Unmarshal([]byte(task.Context), &generic)
			workspace, _ := generic["workspace_id"].(string)
			if workspace == "" {
				if raw, ok := generic["payload"].(string); ok {
					var inner struct {
						WorkspaceID string `json:"workspace_id"`
					}
					_ = json.Unmarshal([]byte(raw), &inner)
					workspace = inner.WorkspaceID
				}
			}
			_ = json.Unmarshal([]byte(task.Context), &meta)
			if workspace != event.WorkspaceID || (!jobs[meta.JobID] && !containsVideoReference(task.Request, refs)) {
				continue
			}
			fields := map[string]any{"request": "", "result": "", "last_error": videoContentErased}
			if videoModelTask(task) {
				meta.Frames = nil
				raw, _ := json.Marshal(meta)
				fields["context"] = string(raw)
			}
			if err := tx.Model(&model.FlowModelTask{}).Where("id = ? AND tenant_id = ?", task.ID, event.TenantID).Updates(fields).Error; err != nil {
				return err
			}
		}
	}
	var calls []model.FlowAgentToolCall
	if err := tx.Table("flow_agent_tool_calls tc").Select("tc.*").Joins("JOIN flow_agent_conversations c ON c.id=tc.conversation_id AND c.tenant_id=tc.tenant_id").Where("tc.tenant_id = ? AND c.workspace_id = ?", event.TenantID, event.WorkspaceID).Find(&calls).Error; err != nil {
		return err
	}
	tainted := map[string]bool{}
	var conversations []model.FlowAgentConversation
	if err := tx.Where("tenant_id = ? AND workspace_id = ?", event.TenantID, event.WorkspaceID).Find(&conversations).Error; err != nil {
		return err
	}
	for _, conv := range conversations {
		// Retain only non-content IDs after redaction so an erased follow-up or
		// restored projection can still find previously revoked native runs.
		if containsVideoReference(conv.EvidenceScope, refs) || (payload.Action == "erased" && strings.Contains(conv.EvidenceScope, `"_video_content_erased":true`)) {
			tainted[conv.ID] = true
		}
	}
	for _, call := range calls {
		if !containsVideoReference(call.Arguments, refs) && !containsVideoReference(call.Result, refs) {
			continue
		}
		tainted[call.ConversationID] = true
		result, _ := json.Marshal(ToolResult{CallID: call.CallID, Tool: call.ToolName, Status: "failed", Error: "source content unavailable"})
		if err := tx.Model(&model.FlowAgentToolCall{}).Where("id = ? AND tenant_id = ?", call.ID, event.TenantID).Updates(map[string]any{"arguments": "{}", "result": string(result), "status": "failed"}).Error; err != nil {
			return err
		}
	}
	ids := make([]string, 0, len(tainted))
	for conversationID := range tainted {
		ids = append(ids, conversationID)
		var conv model.FlowAgentConversation
		if err := tx.Where("id = ? AND tenant_id = ? AND workspace_id = ?", conversationID, event.TenantID, event.WorkspaceID).First(&conv).Error; err != nil {
			return err
		}
		marker := map[string]any{}
		_ = json.Unmarshal([]byte(conv.EvidenceScope), &marker)
		retainedIDs := map[string]bool{}
		if old, ok := marker["_video_revocation_refs"].([]any); ok {
			for _, id := range old {
				if id, ok := id.(string); ok {
					retainedIDs[id] = true
				}
			}
		}
		for id := range refs {
			retainedIDs[id] = true
		}
		retained := make([]string, 0, len(retainedIDs))
		for id := range retainedIDs {
			retained = append(retained, id)
		}
		sort.Strings(retained)
		marker["_video_revocation_refs"] = retained
		marker["_video_content_revoked"] = true
		if payload.Action == "erased" {
			marker["_video_content_erased"] = true
		}
		markerRaw, _ := json.Marshal(marker)
		if err := tx.Model(&conv).Update("evidence_scope", string(markerRaw)).Error; err != nil {
			return err
		}
		if payload.Action == "erased" {
			// Assistant summaries/tool turns are derived from this conversation's
			// material; preserve user-authored messages and immutable audit IDs.
			if err := tx.Model(&model.FlowAgentMessage{}).Where("tenant_id = ? AND conversation_id = ? AND role <> ?", event.TenantID, conversationID, "user").Updates(map[string]any{"content": "", "tombstoned_at": time.Now().UTC(), "revision": gorm.Expr("revision + 1")}).Error; err != nil {
				return err
			}
			if err := tx.Model(&model.FlowAgentConversation{}).Where("id = ? AND tenant_id = ? AND workspace_id = ?", conversationID, event.TenantID, event.WorkspaceID).Updates(map[string]any{"title": "Source content unavailable", "summary": "", "confirmed_plans": "[]", "current_topic_id": ""}).Error; err != nil {
				return err
			}
			if err := SyncConversationToCanvas(tx, conversationID); err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
		}
	}
	videoProjectionPurger.RLock()
	purger := videoProjectionPurger.fn
	videoProjectionPurger.RUnlock()
	if purger != nil && len(ids) > 0 {
		return purger(tx, event.TenantID, event.WorkspaceID, ids, payload.Action == "erased")
	}
	return nil
}

func containsVideoReference(raw string, refs map[string]bool) bool {
	var walk func(any, int) bool
	walk = func(value any, depth int) bool {
		if depth > 24 {
			return false
		}
		switch value := value.(type) {
		case string:
			if refs[value] {
				return true
			}
			var nested any
			if len(value) > 1 && (value[0] == '{' || value[0] == '[') && json.Unmarshal([]byte(value), &nested) == nil {
				return walk(nested, depth+1)
			}
		case []any:
			for _, item := range value {
				if walk(item, depth+1) {
					return true
				}
			}
		case map[string]any:
			for _, item := range value {
				if walk(item, depth+1) {
					return true
				}
			}
		}
		return false
	}
	var value any
	return json.Unmarshal([]byte(raw), &value) == nil && walk(value, 0)
}
