package flow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"yingce/backend/internal/model"
)

var ErrVideoProjectionUnavailable = errors.New("flow: video-derived projection quarantined until authoritative deletion history is verified")
var ErrVideoContentErased = errors.New("flow: video-derived conversation content was erased")
var ErrVideoContentRevoked = fmt.Errorf("%w: conversation authority revoked", ErrVideoProjectionUnavailable)

type videoProjectionPage struct {
	JournalID          string  `json:"journal_id"`
	GenesisHash        string  `json:"genesis_hash"`
	HeadSequence       int64   `json:"head_sequence"`
	HeadHash           string  `json:"head_hash"`
	ProjectionSequence int64   `json:"projection_sequence"`
	Items              []Event `json:"items"`
	NextCursor         *int64  `json:"next_cursor"`
}

// ReconcileVideoProjection is a derived-cache barrier, not another source of
// business truth. A fresh authoritative checkpoint is required on EVERY read;
// restoring an old Go DB therefore cannot restore a permission to expose data.
func ReconcileVideoProjection(ctx context.Context, db *gorm.DB, cfg Config, scope Scope) error {
	if !cfg.Enabled() || scope.TenantID == "" || scope.WorkspaceID == "" {
		return ErrVideoProjectionUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	checkpointID := "vp_" + hashJSON([]string{scope.TenantID, scope.WorkspaceID})[:48]
	var checkpoint model.FlowEventInbox
	var prior videoProjectionPage
	if err := db.Where("consumer_id = ? AND event_id = ? AND tenant_id = ?", "video-projection-watermark", checkpointID, scope.TenantID).First(&checkpoint).Error; err == nil {
		if json.Unmarshal([]byte(checkpoint.Payload), &prior) != nil {
			return ErrVideoProjectionUnavailable
		}
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return ErrVideoProjectionUnavailable
	}
	cursor := prior.ProjectionSequence
	fetch := func(cursor int64, expected *videoProjectionPage) (videoProjectionPage, error) {
		var page videoProjectionPage
		query := url.Values{"cursor": {fmt.Sprint(cursor)}, "limit": {"100"}}
		if expected != nil {
			query.Set("journal_id", expected.JournalID)
			query.Set("genesis_hash", expected.GenesisHash)
			query.Set("head_sequence", fmt.Sprint(expected.HeadSequence))
			query.Set("head_hash", expected.HeadHash)
			query.Set("projection_sequence", fmt.Sprint(expected.ProjectionSequence))
		}
		claim := ExecutionContext{Issuer: cfg.Issuer, Audience: cfg.Audience, TenantID: scope.TenantID, WorkspaceID: scope.WorkspaceID, Actor: Actor{Type: "service_principal", ID: "video-projection-reader"}, Scopes: []string{"intel.video.read"}, PolicyVersion: "video_projection_v1"}
		token, err := Sign(cfg.SigningKey, claim, time.Now(), time.Minute)
		if err != nil {
			return page, err
		}
		req, err := http.NewRequestWithContext(ctx, "GET", cfg.EngineURL+"/v1/video/retention/projection-feed?"+query.Encode(), nil)
		if err != nil {
			return page, err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		client := &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return ErrEgressBlocked }}
		resp, err := client.Do(req)
		if err != nil {
			return page, err
		}
		defer resp.Body.Close()
		var envelope struct {
			Data videoProjectionPage `json:"data"`
		}
		if resp.StatusCode != 200 || json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&envelope) != nil {
			return page, ErrVideoProjectionUnavailable
		}
		page = envelope.Data
		if page.JournalID == "" || len(page.GenesisHash) != 64 || len(page.HeadHash) != 64 || page.HeadSequence < 0 || page.ProjectionSequence < cursor || len(page.Items) > 100 {
			return page, ErrVideoProjectionUnavailable
		}
		if expected != nil && (page.JournalID != expected.JournalID || page.GenesisHash != expected.GenesisHash || page.HeadHash != expected.HeadHash || page.HeadSequence != expected.HeadSequence || page.ProjectionSequence != expected.ProjectionSequence) {
			return page, ErrVideoProjectionUnavailable
		}
		return page, nil
	}
	var head *videoProjectionPage
	for pages := 0; pages < 1000; pages++ {
		page, err := fetch(cursor, head)
		if err != nil {
			return ErrVideoProjectionUnavailable
		}
		if head == nil {
			if prior.JournalID != "" && (page.JournalID != prior.JournalID || page.GenesisHash != prior.GenesisHash || page.HeadSequence < prior.HeadSequence || (page.HeadSequence == prior.HeadSequence && page.HeadHash != prior.HeadHash)) {
				return ErrVideoProjectionUnavailable
			}
			copy := page
			head = &copy
		}
		for _, event := range page.Items {
			if event.Type != "knowledge.dependencies_revoked" || event.TenantID != scope.TenantID || event.WorkspaceID != scope.WorkspaceID || event.Sequence <= cursor || event.Sequence > head.ProjectionSequence {
				return ErrVideoProjectionUnavailable
			}
			if _, err := ConsumeEvent(db, "video-projection-replay", event); err != nil {
				return ErrVideoProjectionUnavailable
			}
			// Reapply the idempotent scrub, even if an older live inbox saw the ID.
			if err := db.Transaction(func(tx *gorm.DB) error { return purgeVideoCaches(tx, event) }); err != nil {
				return ErrVideoProjectionUnavailable
			}
			cursor = event.Sequence
		}
		if page.NextCursor != nil {
			if *page.NextCursor != cursor || *page.NextCursor <= prior.ProjectionSequence || len(page.Items) == 0 {
				return ErrVideoProjectionUnavailable
			}
			cursor = *page.NextCursor
			continue
		}
		if cursor != head.ProjectionSequence {
			return ErrVideoProjectionUnavailable
		}
		if _, err := fetch(cursor, head); err != nil {
			return ErrVideoProjectionUnavailable
		}
		watermark := *head
		watermark.Items = nil
		watermark.NextCursor = nil
		raw, _ := json.Marshal(watermark)
		row := model.FlowEventInbox{ConsumerID: "video-projection-watermark", EventID: checkpointID, TenantID: scope.TenantID, OperationID: checkpointID, Type: "video.projection_checkpoint", Payload: string(raw), ReceivedAt: time.Now().UTC()}
		if err := db.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "consumer_id"}, {Name: "event_id"}}, DoUpdates: clause.AssignmentColumns([]string{"payload", "received_at"})}).Create(&row).Error; err != nil {
			return ErrVideoProjectionUnavailable
		}
		return nil
	}
	return ErrVideoProjectionUnavailable
}

func ensureConversationVideoProjection(db *gorm.DB, conv model.FlowAgentConversation) error {
	return ensureConversationVideoProjectionContext(context.Background(), db, conv)
}

func ensureConversationVideoProjectionContext(ctx context.Context, db *gorm.DB, conv model.FlowAgentConversation) error {
	var calls []model.FlowAgentToolCall
	if err := db.Where("tenant_id = ? AND conversation_id = ?", conv.TenantID, conv.ID).Find(&calls).Error; err != nil {
		return err
	}
	video := strings.Contains(conv.EvidenceScope, "_video_content_erased") || strings.Contains(conv.EvidenceScope, "_video_content_revoked")
	for _, call := range calls {
		video = video || strings.Contains(call.ToolName, "knowledge") || strings.Contains(call.ToolName, "video") || videoProjectionMarker(call.Result)
	}
	if !video {
		return nil
	}
	if err := ReconcileVideoProjection(ctx, db, ConfigFromEnv(), Scope{TenantID: conv.TenantID, WorkspaceID: conv.WorkspaceID}); err != nil {
		return err
	}
	if err := db.First(&conv, "id = ?", conv.ID).Error; err != nil {
		return err
	}
	if strings.Contains(conv.EvidenceScope, `"_video_content_revoked":true`) && !strings.Contains(conv.EvidenceScope, `"_video_content_erased":true`) {
		return ErrVideoContentRevoked
	}
	return nil
}

// Native Agent adapters call this BEFORE reading/restoring/writing a linked
// conversation's opaque execution/session checkpoint. Empty links are legacy
// non-Flow runs; they confer no permission to read another user's conversation.
func CheckVideoConversationProjection(ctx context.Context, db *gorm.DB, userID, conversationID string) error {
	if conversationID == "" {
		return nil
	}
	var conv model.FlowAgentConversation
	if err := db.Where("id = ? AND user_id = ?", conversationID, userID).First(&conv).Error; err != nil {
		return ErrNotFound
	}
	if err := ensureConversationVideoProjectionContext(ctx, db, conv); err != nil {
		return err
	}
	if err := db.Where("id = ? AND user_id = ?", conversationID, userID).First(&conv).Error; err != nil {
		return ErrNotFound
	}
	if strings.Contains(conv.EvidenceScope, `"_video_content_erased":true`) {
		return ErrVideoContentErased
	}
	if strings.Contains(conv.EvidenceScope, `"_video_content_revoked":true`) {
		return ErrVideoContentRevoked
	}
	return nil
}

func videoProjectionMarker(raw string) bool {
	return strings.Contains(raw, "bilibili.com/") || strings.Contains(raw, "douyin.com/") || strings.Contains(raw, `"video_derived":true`) || strings.Contains(raw, `"video_job_id"`) || strings.Contains(raw, `"knowledge_snapshot"`) || strings.Contains(raw, `"_video_content_erased":true`)
}

func videoSensitiveEvent(db *gorm.DB, tenant, workspace, eventID string) (bool, error) {
	var rows []model.FlowEventInbox
	if err := db.Where("tenant_id = ? AND event_id = ?", tenant, eventID).Find(&rows).Error; err != nil {
		return true, err
	}
	for _, row := range rows {
		if videoProjectionMarker(row.Payload) {
			return true, nil
		}
	}
	return false, nil
}

func ensureNotificationVideoProjection(db *gorm.DB, scope Scope) error {
	var rows []model.FlowNotification
	if err := db.Where("tenant_id = ? AND workspace_id = ?", scope.TenantID, scope.WorkspaceID).Find(&rows).Error; err != nil {
		return err
	}
	for _, row := range rows {
		video, err := videoSensitiveEvent(db, scope.TenantID, scope.WorkspaceID, row.EventID)
		if err != nil {
			return err
		}
		if video {
			return ReconcileVideoProjection(context.Background(), db, ConfigFromEnv(), scope)
		}
	}
	return nil
}

func ensureCanvasVideoProjection(db *gorm.DB, userID, canvasID string) error {
	var conversations []model.FlowAgentConversation
	if err := db.Where("user_id = ? AND subject_kind = ? AND subject_id = ?", userID, SubjectCanvas, canvasID).Find(&conversations).Error; err != nil {
		return err
	}
	for _, conv := range conversations {
		if err := ensureConversationVideoProjection(db, conv); err != nil {
			return err
		}
	}
	return nil
}

func sanitizeVideoCanvasHistory(db *gorm.DB, userID, canvasID string, raw json.RawMessage) (json.RawMessage, error) {
	var erased []model.FlowAgentConversation
	if err := db.Where("user_id = ? AND subject_kind = ? AND subject_id = ? AND evidence_scope LIKE ?", userID, SubjectCanvas, canvasID, `%"_video_content_erased":true%`).Find(&erased).Error; err != nil {
		return nil, err
	}
	if len(erased) == 0 {
		return raw, nil
	}
	ids := map[string]bool{}
	for _, conv := range erased {
		ids[conv.ExternalID] = true
	}
	var root map[string]any
	if json.Unmarshal(raw, &root) != nil {
		return nil, ErrInvalid
	}
	list, _ := root["conversations"].([]any)
	for _, item := range list {
		conv, _ := item.(map[string]any)
		id, _ := conv["id"].(string)
		if !ids[id] {
			continue
		}
		messages, _ := conv["messages"].([]any)
		keep := []any{}
		for _, item := range messages {
			message, _ := item.(map[string]any)
			if message["role"] == "user" {
				keep = append(keep, message)
			}
		}
		conv["messages"], conv["title"] = keep, "Source content unavailable"
		delete(conv, "summary")
	}
	return json.Marshal(root)
}
