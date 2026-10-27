package flow

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"yingce/backend/internal/model"
)

// The existing credit reservation is the admission/receipt. There is no second
// video billing ledger; Note stores only the frozen metering contract.
type videoUsageAdmission struct {
	WorkspaceID    string `json:"w"`
	JobID          string `json:"j"`
	UsageType      string `json:"u"`
	QuantityLimit  int64  `json:"q"`
	UnitPriceMicro int64  `json:"p"`
	PriceVersion   string `json:"v"`
	StageAttempt   int    `json:"a"`
	FencingToken   int64  `json:"f"`
	Outcome        string `json:"o,omitempty"`
	ActualQuantity int64  `json:"n,omitempty"`
}

func videoUsageView(r model.FlowBudgetReservation, note videoUsageAdmission) map[string]any {
	return map[string]any{"admission_id": r.ID, "reservation_id": r.ID, "status": r.Status, "quantity_limit": note.QuantityLimit, "quantity": note.ActualQuantity, "unit_price_micro": note.UnitPriceMicro, "price_version": note.PriceVersion, "reserved_micro": r.ReservedMicro, "cost_micro": r.ConsumedMicro, "workspace_id": note.WorkspaceID, "video_job_id": note.JobID, "usage_type": note.UsageType, "usage_ref": "video-usage:" + r.ID, "may_execute": r.Status == "reserved"}
}

func decodeVideoUsage(c *gin.Context, out any) bool {
	d := json.NewDecoder(io.LimitReader(c.Request.Body, 64<<10))
	d.DisallowUnknownFields()
	if d.Decode(out) != nil || d.Decode(new(any)) != io.EOF {
		videoReply(c, 400, "invalid_usage_request")
		return false
	}
	return true
}

func registerVideoUsageRoutes(api gin.IRouter, db *gorm.DB, cfg Config) {
	api.POST("/internal/flow/video/model-budget/close", func(c *gin.Context) {
		claim, ok := internalServiceCtx(c, cfg)
		if !ok {
			return
		}
		var in struct {
			Purpose string `json:"purpose"`
		}
		if !decodeVideoUsage(c, &in) {
			return
		}
		if claim.JobID == "" || !claim.HasScope("intel.video.model") || (in.Purpose != "video_knowledge_extract" && in.Purpose != "video_skill_evaluate") || !videoModelActorAllowed(claim, in.Purpose) {
			videoReply(c, 403, "model_budget_scope_required")
			return
		}
		var parents []model.FlowBudgetReservation
		if err := db.Where("tenant_id = ? AND ref_id = ? AND purpose = ? AND note = ?", claim.TenantID, claim.JobID, "video_model_parent", "video-parent:"+claim.WorkspaceID+":"+in.Purpose).Limit(2).Find(&parents).Error; err != nil {
			videoReply(c, 503, "model_parent_budget_unavailable")
			return
		}
		if len(parents) == 0 {
			videoReply(c, 404, "model_parent_budget_not_found")
			return
		}
		if len(parents) != 1 {
			videoReply(c, 409, "model_parent_budget_ambiguous")
			return
		}
		r, err := (Billing{DB: db}).Settle(parents[0].ID, 0)
		if err != nil {
			videoReply(c, 409, "model_budget_children_pending")
			return
		}
		reply(c, 200, map[string]any{"reservation_id": r.ID, "status": r.Status, "cost_micro": r.ConsumedMicro}, "settled")
	})
	authenticated := func(c *gin.Context) (ExecutionContext, bool) {
		claim, ok := internalServiceCtx(c, cfg)
		if !ok {
			return claim, false
		}
		if claim.JobID == "" || !claim.HasScope("intel.video.model") || (claim.Actor.ID != "loom-video-worker" && claim.Actor.ID != "loom-engine" && claim.Actor.ID != "video-usage-reconciler") {
			videoReply(c, 403, "video_meter_service_required")
			return claim, false
		}
		return claim, true
	}
	api.POST("/internal/flow/video/usage-admission", func(c *gin.Context) {
		claim, ok := authenticated(c)
		if !ok {
			return
		}
		if claim.Actor.ID != "loom-video-worker" {
			videoReply(c, 403, "video_worker_required")
			return
		}
		var in struct {
			Key          string `json:"key"`
			UsageType    string `json:"usage_type"`
			Quantity     int64  `json:"quantity"`
			StageAttempt int    `json:"stage_attempt"`
			FencingToken int64  `json:"fencing_token"`
		}
		if !decodeVideoUsage(c, &in) {
			return
		}
		if in.Key == "" || len(in.Key) > 200 || in.Quantity < 1 || in.Quantity > 360000 || in.StageAttempt < 1 || in.FencingToken < 1 || (in.UsageType != UsageASRSeconds && in.UsageType != UsageOCRPages) {
			videoReply(c, 400, "invalid_usage_quantum")
			return
		}
		auth, err := authorizeVideoModel(c.Request.Context(), cfg, claim.TenantID, claim.WorkspaceID, claim.JobID, "video_usage", in.StageAttempt, in.FencingToken)
		if err != nil {
			videoModelAuthFailure(c, err)
			return
		}
		if err := AuthorizeGrant(db, auth.GrantActor, claim.TenantID, claim.WorkspaceID, "intel.video.process"); err != nil {
			videoReply(c, 403, "grant_revoked")
			return
		}
		if auth.BudgetReservationID == "" {
			videoReply(c, 402, "profile_budget_required")
			return
		}
		pb := CurrentPriceBook()
		unit, priced := pb.UnitMicro[in.UsageType]
		if !priced || len(pb.Version) > 40 || unit < 0 || (unit > 0 && in.Quantity > math.MaxInt64/unit) {
			videoReply(c, 503, "usage_price_unavailable")
			return
		}
		note := videoUsageAdmission{WorkspaceID: claim.WorkspaceID, JobID: claim.JobID, UsageType: in.UsageType, QuantityLimit: in.Quantity, UnitPriceMicro: unit, PriceVersion: pb.Version, StageAttempt: in.StageAttempt, FencingToken: in.FencingToken}
		key := "video-usage:" + hashJSON([]string{claim.WorkspaceID, claim.JobID, in.Key})
		var reservation model.FlowBudgetReservation
		err = db.Transaction(func(tx *gorm.DB) error {
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("tenant_id = ? AND idempotency_key = ?", claim.TenantID, key).First(&reservation).Error; err == nil {
				var prior videoUsageAdmission
				if json.Unmarshal([]byte(reservation.Note), &prior) != nil || prior.WorkspaceID != note.WorkspaceID || prior.JobID != note.JobID || prior.UsageType != note.UsageType || prior.QuantityLimit != note.QuantityLimit || note.StageAttempt < prior.StageAttempt || note.FencingToken < prior.FencingToken {
					return ErrCommandConflict
				}
				prior.StageAttempt, prior.FencingToken = note.StageAttempt, note.FencingToken
				note = prior
				raw, _ := json.Marshal(note)
				return tx.Model(&reservation).Update("note", string(raw)).Error
			} else if !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
			amount := unit * in.Quantity
			if amount == 0 {
				amount = 1
			} // minimal hold also makes zero-priced work durable and quota-bound
			var e error
			reservation, e = (Billing{DB: tx}).Allocate(auth.BudgetReservationID, key, "video_usage", claim.JobID, amount)
			if e != nil {
				return e
			}
			if reservation.TenantID != claim.TenantID || reservation.ParentID != auth.BudgetReservationID {
				return ErrForbidden
			}
			raw, _ := json.Marshal(note)
			return tx.Model(&reservation).Updates(map[string]any{"note": string(raw), "price_version": pb.Version}).Error
		})
		if err != nil {
			if errors.Is(err, ErrCommandConflict) {
				videoReply(c, 409, "usage_idempotency_conflict")
			} else {
				videoReply(c, 402, "blocked_budget")
			}
			return
		}
		reply(c, 200, videoUsageView(reservation, note), "admitted")
	})
	api.POST("/internal/flow/video/usage-settle", func(c *gin.Context) {
		claim, ok := authenticated(c)
		if !ok {
			return
		}
		var in struct {
			AdmissionID  string `json:"admission_id"`
			Quantity     int64  `json:"quantity"`
			Outcome      string `json:"outcome"`
			StageAttempt int    `json:"stage_attempt"`
			FencingToken int64  `json:"fencing_token"`
		}
		if !decodeVideoUsage(c, &in) {
			return
		}
		if in.AdmissionID == "" || in.Quantity < 0 || in.StageAttempt < 1 || in.FencingToken < 1 || (in.Outcome != "completed" && in.Outcome != "not_processed" && in.Outcome != "unknown") {
			videoReply(c, 400, "invalid_usage_outcome")
			return
		}
		if _, err := authorizeVideoModel(c.Request.Context(), cfg, claim.TenantID, claim.WorkspaceID, claim.JobID, "video_usage_settle", in.StageAttempt, in.FencingToken); err != nil {
			videoModelAuthFailure(c, err)
			return
		}
		var r model.FlowBudgetReservation
		var note videoUsageAdmission
		err := db.Transaction(func(tx *gorm.DB) error {
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND tenant_id = ? AND purpose = ?", in.AdmissionID, claim.TenantID, "video_usage").First(&r).Error; err != nil {
				return ErrNotFound
			}
			if json.Unmarshal([]byte(r.Note), &note) != nil || note.JobID != claim.JobID || note.WorkspaceID != claim.WorkspaceID || note.StageAttempt != in.StageAttempt || note.FencingToken != in.FencingToken {
				return ErrForbidden
			}
			if in.Quantity > note.QuantityLimit || (in.Outcome != "completed" && in.Quantity != 0) {
				return ErrCommandConflict
			}
			if r.Status == "settled" || r.Status == "released" {
				if note.Outcome != in.Outcome || note.ActualQuantity != in.Quantity {
					return ErrCommandConflict
				}
				return nil
			}
			b := Billing{DB: tx}
			var err error
			if in.Outcome == "unknown" {
				if r.Status == StatusReconciliation {
					return nil
				}
				err = b.MarkUnknown(r.ID, r.ID, r.Note)
				r.Status = StatusReconciliation
				return err
			}
			if in.Outcome == "not_processed" {
				r, err = b.Release(r.ID)
			} else {
				r, err = b.Settle(r.ID, in.Quantity*note.UnitPriceMicro)
			}
			if err != nil {
				return err
			}
			note.Outcome, note.ActualQuantity = in.Outcome, in.Quantity
			raw, _ := json.Marshal(note)
			if err := tx.Model(&r).Update("note", string(raw)).Error; err != nil {
				return err
			}
			if in.Outcome == "completed" {
				row := model.FlowUsageRecord{ID: NewID("use_"), TenantID: claim.TenantID, WorkspaceID: claim.WorkspaceID, UsageType: note.UsageType, Quantity: in.Quantity, UnitPriceMicro: note.UnitPriceMicro, CostMicro: r.ConsumedMicro, PriceVersion: note.PriceVersion, ReservationID: r.ID, SubjectRef: "video_job:" + claim.JobID, Status: "charged", IdemKey: "video-usage:" + r.ID, CreatedAt: time.Now().UTC()}
				return tx.Create(&row).Error
			}
			return nil
		})
		if err != nil {
			videoReply(c, 409, "usage_settlement_conflict")
			return
		}
		reply(c, 200, videoUsageView(r, note), "reconciled")
	})
	api.GET("/internal/flow/video/budget", func(c *gin.Context) {
		claim, ok := authenticated(c)
		if !ok {
			return
		}
		auth, err := authorizeVideoModel(c.Request.Context(), cfg, claim.TenantID, claim.WorkspaceID, claim.JobID, "video_usage_settle", 0, 0)
		if err != nil {
			videoModelAuthFailure(c, err)
			return
		}
		var parent model.FlowBudgetReservation
		if auth.BudgetReservationID == "" {
			videoReply(c, 404, "job_budget_not_found")
			return
		}
		if err := db.Where("id = ? AND tenant_id = ? AND ref_id = ?", auth.BudgetReservationID, claim.TenantID, claim.JobID).First(&parent).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				videoReply(c, 404, "job_budget_not_found")
			} else {
				videoReply(c, 503, "job_budget_unavailable")
			}
			return
		}
		var open, unknown int64
		if err := db.Model(&model.FlowBudgetReservation{}).Where("parent_id = ? AND status IN ?", parent.ID, []string{"reserved", StatusReconciliation}).Count(&open).Error; err != nil {
			videoReply(c, 503, "job_budget_unavailable")
			return
		}
		if err := db.Model(&model.FlowBudgetReservation{}).Where("parent_id = ? AND status = ?", parent.ID, StatusReconciliation).Count(&unknown).Error; err != nil {
			videoReply(c, 503, "job_budget_unavailable")
			return
		}
		reply(c, 200, map[string]any{"reservation_id": parent.ID, "status": parent.Status, "reserved_micro": parent.ReservedMicro, "allocated_micro": parent.AllocatedMicro, "consumed_micro": parent.ConsumedMicro, "remaining_micro": parent.ReservedMicro - parent.AllocatedMicro - parent.ConsumedMicro, "open_children": open, "unknown_children": unknown}, "ok")
	})
}
