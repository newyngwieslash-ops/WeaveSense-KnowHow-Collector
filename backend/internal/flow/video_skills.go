package flow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"yingce/backend/internal/model"
)

type VideoKnowledgeSnapshot struct {
	ID          string   `json:"id"`
	RunID       string   `json:"run_id"`
	Method      SkillRef `json:"method"`
	ContentHash string   `json:"content_hash"`
}

func videoMethodSkill(skill Skill) bool {
	return skill.ID == "video-knowledge-core" || governedVideoSkill(skill)
}

func videoSkillToolsAvailable(db *gorm.DB, scope Scope, skill Skill) error {
	if !videoMethodSkill(skill) {
		return nil
	}
	ps, err := SkillPacks()
	if err != nil {
		return err
	}
	for _, pack := range ps {
		if pack.ID != skill.PackID || !skillPackContains(pack, skill) {
			continue
		}
		var missing []string
		for _, name := range pack.RequiredTools {
			spec, exists := FindTool(name)
			if !exists || !hasScope(scope.Role, spec.Scope) {
				missing = append(missing, "tool:"+name)
			}
		}
		for _, connection := range pack.MCPRequirements {
			var count int64
			if err := db.Model(&model.FlowMCPConnection{}).Where("tenant_id = ? AND workspace_id = ? AND name = ? AND status = ?", scope.TenantID, scope.WorkspaceID, connection, "approved").Count(&count).Error; err != nil {
				return err
			}
			if count == 0 {
				missing = append(missing, "approved_connection:"+connection)
			}
		}
		if len(missing) > 0 {
			return fmt.Errorf("flow: video skill prerequisites unavailable: %s", strings.Join(missing, ", "))
		}
		return nil
	}
	return ErrSkillNotFound
}

func withVideoKnowledgeSnapshot(scope Scope, runID string, skill Skill) (Skill, error) {
	if !videoMethodSkill(skill) || runID == "" {
		return skill, nil
	}
	cfg := ConfigFromEnv()
	if !cfg.Enabled() {
		return Skill{}, errors.New("flow: knowledge snapshot authority unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	body, _ := json.Marshal(map[string]any{"run_id": runID, "method": skill.Ref()})
	status, raw, err := (EngineClient{Cfg: cfg}).Do(ctx, scope, Actor{Type: "service_principal", ID: "video-skill-reader"}, "POST", "/v1/knowledge/snapshots", "snapshot:"+runID, body)
	var env struct {
		Data VideoKnowledgeSnapshot `json:"data"`
	}
	if err != nil || status != 200 || json.Unmarshal(raw, &env) != nil || env.Data.ID == "" || len(env.Data.ContentHash) != 64 || env.Data.RunID != runID || env.Data.Method != skill.Ref() {
		return Skill{}, fmt.Errorf("flow: knowledge snapshot pin unavailable (status %d)", status)
	}
	skill.KnowledgeSnapshot = &env.Data
	return skill, nil
}

func (t Tools) pinnedVideoKnowledgeSnapshot(scope Scope, conversationID string) (*VideoKnowledgeSnapshot, error) {
	runID := t.RunID
	if runID == "" {
		runID = "conv:" + conversationID
	}
	var pins []model.FlowSkillRunPin
	if err := t.DB.Where("tenant_id = ? AND run_id = ?", scope.TenantID, runID).Find(&pins).Error; err != nil {
		return nil, err
	}
	for _, pin := range pins {
		sk, found := FindSkill(pin.SkillID, pin.Version)
		if !found || !videoMethodSkill(sk) {
			continue
		}
		if pin.Hash != sk.Hash {
			return nil, ErrSkillNotFound
		}
		if err := checkRuntimeVideoSkill(scope, sk); err != nil {
			return nil, err
		}
		sk, err := withVideoKnowledgeSnapshot(scope, runID, sk)
		if err != nil {
			return nil, err
		}
		return sk.KnowledgeSnapshot, nil
	}
	return nil, nil
}

func governedVideoSkill(skill Skill) bool {
	p, ok := skillPackFor(skill)
	return ok && p.Kind == "video-method"
}

type videoSkillAvailability struct {
	Available       bool   `json:"available"`
	CandidateID     string `json:"candidate_id"`
	CandidateHash   string `json:"candidate_hash"`
	NativeSkillHash string `json:"native_skill_hash"`
}

func checkVideoSkill(ctx context.Context, engine EngineCaller, scope Scope, skill Skill) (videoSkillAvailability, error) {
	var result videoSkillAvailability
	if !skillVisibleInScope(scope, skill) {
		return result, ErrSkillNotFound
	}
	if !governedVideoSkill(skill) {
		result.Available = true
		return result, nil
	}
	if engine == nil {
		return result, ErrSkillNotFound
	}
	body, _ := json.Marshal(map[string]any{"skill_id": skill.ID, "version": skill.Version, "hash": skill.Hash})
	cctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	status, raw, err := engine.Do(cctx, scope, Actor{Type: "service_principal", ID: "video-skill-reader"}, "POST", "/v1/video/skill-candidates/check-pin", "", body)
	var env struct {
		Data videoSkillAvailability `json:"data"`
	}
	if err != nil || status != 200 || json.Unmarshal(raw, &env) != nil || !env.Data.Available || env.Data.NativeSkillHash != skill.Hash {
		return result, errors.New("flow: deployed video skill or current evidence dependencies unavailable")
	}
	return env.Data, nil
}

func checkRuntimeVideoSkill(scope Scope, skill Skill) error {
	if !skillVisibleInScope(scope, skill) {
		return ErrSkillNotFound
	}
	if !governedVideoSkill(skill) {
		return nil
	}
	cfg := ConfigFromEnv()
	if !cfg.Enabled() {
		return ErrSkillNotFound
	}
	_, err := checkVideoSkill(context.Background(), EngineClient{Cfg: cfg}, scope, skill)
	return err
}

func registerVideoSkillInstall(g *gin.RouterGroup, db *gorm.DB, engine EngineCaller, scoped func(*gin.Context) (Scope, *model.User, bool)) {
	g.POST("/video/skill-candidates/:id/install", func(c *gin.Context) {
		s, u, ok := scoped(c)
		if !ok {
			return
		}
		if !hasScope(s.Role, "intel.skills.release") {
			videoReply(c, 403, "permission_denied")
			return
		}
		var in struct {
			SkillID             string `json:"skill_id"`
			Version             string `json:"version"`
			Hash                string `json:"hash"`
			ExpectedHash        string `json:"expected_hash"`
			ExpectedInstallHash string `json:"expected_install_hash"`
		}
		if c.ShouldBindJSON(&in) != nil || in.Version == "" || in.Hash == "" || in.ExpectedHash == "" || c.GetHeader("X-Idempotency-Key") == "" {
			videoReply(c, 400, "invalid_install_request")
			return
		}
		sk, found := FindSkill(in.SkillID, in.Version)
		if !found || sk.Hash != in.Hash || !governedVideoSkill(sk) {
			videoReply(c, 409, "native_version_not_in_deployed_build")
			return
		}
		if err := videoSkillToolsAvailable(db, s, sk); err != nil {
			videoReply(c, 409, err.Error())
			return
		}
		availability, err := checkVideoSkill(c.Request.Context(), engine, s, sk)
		if err != nil || availability.CandidateID != c.Param("id") || availability.CandidateHash != in.ExpectedHash {
			videoReply(c, 409, "deployed_candidate_unavailable")
			return
		}
		var installed model.FlowSkillInstall
		var command model.FlowCommandOutbox
		err = db.Transaction(func(tx *gorm.DB) error {
			var e error
			var workspace model.Workspace
			if e = tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND tenant_id = ?", s.WorkspaceID, s.TenantID).First(&workspace).Error; e != nil {
				return e
			}
			currentScope, scopeErr := ResolveScope(tx, u.ID, s.WorkspaceID)
			if scopeErr != nil || currentScope.TenantID != s.TenantID || !hasScope(currentScope.Role, "intel.skills.release") {
				return ErrForbidden
			}
			key := "skill-install:" + s.WorkspaceID + ":" + c.GetHeader("X-Idempotency-Key")
			var prior model.FlowCommandOutbox
			priorErr := tx.Where("tenant_id = ? AND idempotency_key = ?", s.TenantID, key).First(&prior).Error
			if priorErr == nil {
				var receipt map[string]any
				if json.Unmarshal([]byte(prior.Payload), &receipt) != nil || receipt["skill_id"] != sk.ID || receipt["version"] != sk.Version || receipt["hash"] != sk.Hash || receipt["expected_hash"] != in.ExpectedHash || receipt["expected_install_hash"] != in.ExpectedInstallHash {
					return ErrCommandConflict
				}
				command = prior
				return tx.Where("tenant_id = ? AND workspace_id = ? AND skill_id = ?", s.TenantID, s.WorkspaceID, sk.ID).First(&installed).Error
			}
			if !errors.Is(priorErr, gorm.ErrRecordNotFound) {
				return priorErr
			}
			var current model.FlowSkillInstall
			currentErr := tx.Where("tenant_id = ? AND workspace_id = ? AND skill_id = ?", s.TenantID, s.WorkspaceID, sk.ID).First(&current).Error
			if currentErr != nil && !errors.Is(currentErr, gorm.ErrRecordNotFound) {
				return currentErr
			}
			if (currentErr == nil && current.Hash != sk.Hash && in.ExpectedInstallHash != current.Hash) || (in.ExpectedInstallHash != "" && in.ExpectedInstallHash != current.Hash) {
				return ErrCommandConflict
			}
			installed, e = installSkillPin(tx, s, u.ID, sk)
			if e != nil {
				return e
			}
			// The receipt proves this local pin, not a deployment. The deployment
			// receipt must already exist in Loom before check-pin can authorize it.
			body, _ := json.Marshal(map[string]any{"kind": "workspace_installed", "skill_id": sk.ID, "version": sk.Version, "hash": sk.Hash, "expected_hash": in.ExpectedHash, "expected_install_hash": in.ExpectedInstallHash,
				"receipt_id": installed.ID + ":" + c.GetHeader("X-Idempotency-Key"), "build_revision": "embedded-pack-sha256:" + sk.Hash})
			command, _, e = (CommandDispatcher{DB: tx, Engine: engine}).Enqueue(c.Request.Context(), CommandInput{Scope: s, Actor: Actor{Type: "service_principal", ID: "video-skill-installer"}, Command: "video.skill.installed", Method: http.MethodPost,
				Path: "/v1/video/skill-candidates/" + url.PathEscape(c.Param("id")) + "/receipts", IdempotencyKey: "skill-install:" + s.WorkspaceID + ":" + c.GetHeader("X-Idempotency-Key"), Payload: body})
			return e
		})
		if err != nil {
			videoReply(c, 409, "install_receipt_conflict")
			return
		}
		dispatched, dispatchErr := (CommandDispatcher{DB: db, Engine: engine}).DispatchOne(c.Request.Context(), command.ID)
		receiptStatus := dispatched.Status
		if dispatchErr != nil && receiptStatus == "" {
			receiptStatus = "pending"
		}
		reply(c, 200, gin.H{"installed": installed, "receipt_status": receiptStatus, "receipt_operation_id": command.OperationID, "deployment": "previously_verified", "run_pins_unchanged": true}, "installed")
	})
}
