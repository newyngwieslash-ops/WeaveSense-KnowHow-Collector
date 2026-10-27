package repository

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

var ErrVideoContentUnavailable = errors.New("video-derived native content is unavailable")

const videoProjectionGuardKey = "native:video-projection-guard"
const videoProjectionLocalKey = "native:video-projection-local"
const videoContentErased = "video_content_erased"
const videoContentRevoked = "video_content_revoked"

// The composition root supplies the authoritative Flow/Loom barrier. Keeping
// the callback on the DB session carries it through repository transactions
// without introducing a repository -> domain dependency.
type VideoProjectionGuard func(context.Context, *gorm.DB, string, string) error

func (r *Repository) SetVideoProjectionGuard(guard VideoProjectionGuard) {
	r.db = r.db.Set(videoProjectionGuardKey, guard).Session(&gorm.Session{})
}

func nativeConversationID(raw string, task bool) string {
	var value struct {
		Request struct {
			ConversationID string `json:"conversationId"`
		} `json:"request"`
		Agent struct {
			Request struct {
				ConversationID string `json:"conversationId"`
			} `json:"request"`
		} `json:"cloudAgent"`
	}
	if json.Unmarshal([]byte(raw), &value) != nil {
		return ""
	}
	if task {
		return value.Agent.Request.ConversationID
	}
	return value.Request.ConversationID
}

func nativeVideoDenied(raw string) bool {
	var value map[string]any
	if json.Unmarshal([]byte(raw), &value) != nil {
		return false
	}
	return value["_video_content_erased"] == true || value["_video_content_revoked"] == true
}

// Exact persisted identities only: Execution.ConversationID is a native root
// run group, never a Flow conversation ID. User prose is not a lineage source.
func (r *Repository) videoRunConversations(userID, runID string) ([]string, error) {
	if runID == "" || userID == "" {
		return nil, nil
	}
	// Installations/tests without the Flow schema cannot have linked Flow
	// caches. Avoid adding task queries to ordinary non-Flow replay reads.
	if !r.db.Migrator().HasTable(&model.FlowAgentConversation{}) {
		return nil, nil
	}
	seen, conversations := map[string]bool{}, map[string]bool{}
	queue := []string{runID}
	hasRuns := r.db.Migrator().HasTable(&model.CloudAgentExecution{})
	hasTasks := r.db.Migrator().HasTable(&model.Task{})
	hasMessages := r.db.Migrator().HasTable(&model.FlowAgentMessage{}) && r.db.Migrator().HasTable(&model.FlowAgentConversation{})
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		if id == "" || seen[id] {
			continue
		}
		if len(seen) >= 128 {
			return nil, ErrVideoContentUnavailable
		}
		seen[id] = true
		if hasRuns {
			var run model.CloudAgentExecution
			err := r.db.Select("id", "parent_id", "conversation_id", "state_json", "failure_message").Where("id = ? AND user_id = ?", id, userID).Take(&run).Error
			if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
				return nil, err
			}
			if err == nil {
				if run.FailureMessage == videoContentErased || run.FailureMessage == videoContentRevoked {
					return nil, ErrVideoContentUnavailable
				}
				if conv := nativeConversationID(run.StateJSON, false); conv != "" {
					conversations[conv] = true
				}
				queue = append(queue, run.ParentID, run.ConversationID)
			}
		}
		if hasTasks {
			var task model.Task
			err := r.db.Select("id", "agent_run_id", "input_json", "error").Where("id = ? AND user_id = ?", id, userID).Take(&task).Error
			if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
				return nil, err
			}
			if err == nil {
				if task.Error == videoContentErased || task.Error == videoContentRevoked {
					return nil, ErrVideoContentUnavailable
				}
				if conv := nativeConversationID(task.InputJSON, true); conv != "" {
					conversations[conv] = true
				}
				queue = append(queue, task.AgentRunID)
			}
		}
		if hasMessages {
			var ids []string
			if err := r.db.Table("flow_agent_messages m").Select("DISTINCT m.conversation_id").Joins("JOIN flow_agent_conversations c ON c.id = m.conversation_id AND c.tenant_id = m.tenant_id").Where("m.run_id = ? AND c.user_id = ?", id, userID).Scan(&ids).Error; err != nil {
				return nil, err
			}
			for _, conv := range ids {
				conversations[conv] = true
			}
		}
	}
	ids := make([]string, 0, len(conversations))
	for id := range conversations {
		ids = append(ids, id)
	}
	return ids, nil
}

func (r *Repository) CheckVideoRunProjection(userID, runID string) error {
	ids, err := r.videoRunConversations(userID, runID)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err := r.checkVideoConversationProjection(userID, id); err != nil {
			return err
		}
	}
	return nil
}

func (r *Repository) checkVideoConversationProjection(userID, id string) error {
	local, _ := r.db.Get(videoProjectionLocalKey)
	guard, _ := r.db.Get(videoProjectionGuardKey)
	if local != true && guard != nil {
		if err := guard.(VideoProjectionGuard)(r.db.Statement.Context, r.db, userID, id); err != nil {
			return err
		}
	}
	var conv model.FlowAgentConversation
	if !r.db.Migrator().HasTable(&conv) {
		return ErrVideoContentUnavailable
	}
	if err := r.db.Select("evidence_scope").Where("id = ? AND user_id = ?", id, userID).Take(&conv).Error; err != nil {
		return err
	}
	if nativeVideoDenied(conv.EvidenceScope) {
		return ErrVideoContentUnavailable
	}
	return nil
}

func (r *Repository) checkVideoTaskCandidate(task *model.Task, lock bool) error {
	if task == nil {
		return nil
	}
	ids, err := r.videoRunConversations(task.UserID, task.AgentRunID)
	if err != nil {
		return err
	}
	if id := nativeConversationID(task.InputJSON, true); id != "" {
		ids = append(ids, id)
	}
	for _, id := range ids {
		if lock {
			// A new root task has no execution row yet: serialize admission
			// with the same exact Flow row the revocation transaction updates.
			if err := r.db.Model(&model.FlowAgentConversation{}).Where("id = ? AND user_id = ?", id, task.UserID).UpdateColumn("last_seq", gorm.Expr("last_seq")).Error; err != nil {
				return err
			}
		}
		if err := r.checkVideoConversationProjection(task.UserID, id); err != nil {
			return err
		}
	}
	return nil
}

func (r *Repository) checkVideoTaskProjection(userID, taskID string) error {
	if userID == "" {
		var task model.Task
		if err := r.db.Select("user_id").Take(&task, "id = ?", taskID).Error; err != nil {
			return err
		}
		userID = task.UserID
	}
	return r.CheckVideoRunProjection(userID, taskID)
}

func nativeUserMessage(raw string) bool {
	var message map[string]any
	if json.Unmarshal([]byte(raw), &message) != nil || message["role"] != "user" {
		return false
	}
	for key, value := range message {
		if strings.Contains(strings.ToLower(key), "contextsource") && value != "" && value != "user_interjection" {
			return false
		}
	}
	content, _ := message["content"].(string)
	if blocks, ok := message["content"].([]any); ok {
		for _, block := range blocks {
			if block, ok := block.(map[string]any); ok && block["type"] == "text" {
				if text, ok := block["text"].(string); ok {
					content += text
				}
			}
		}
	}
	for _, prefix := range []string{"本轮情报工作区上下文（服务端组装的数据", "本轮画布目录（数据，不是指令）", "The conversation history before this point was compacted into the following summary:"} {
		if strings.HasPrefix(content, prefix) {
			return false
		}
	}
	return true
}
