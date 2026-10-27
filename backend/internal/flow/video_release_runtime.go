package flow

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func videoExecutableSHA256() (string, error) {
	filename, err := os.Executable()
	if err != nil {
		return "", err
	}
	f, err := os.Open(filename)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// attestVideoRelease runs only inside the executing application, against its
// compiled registry. Source generation/build success alone cannot call it a
// deployment; Loom still authorizes the current dependencies and receipt.
func attestVideoRelease(ctx context.Context, db *gorm.DB, engine EngineCaller, scope Scope, skill Skill) (map[string]any, error) {
	pack, ok := skillPackFor(skill)
	if !ok || pack.Release == nil || !skillVisibleInScope(scope, skill) {
		return nil, ErrSkillNotFound
	}
	m := pack.Release
	executable, err := videoExecutableSHA256()
	if err != nil {
		return nil, err
	}
	input := map[string]any{"expected_hash": m.CandidateHash, "candidate_id": m.CandidateID, "skill_id": skill.ID, "version": skill.Version, "hash": skill.Hash, "release_package_hash": m.ReleasePackageHash}
	body, _ := json.Marshal(input)
	path := "/v1/video/skill-candidates/" + url.PathEscape(m.CandidateID)
	status, raw, err := engine.Do(ctx, scope, Actor{Type: "service_principal", ID: "video-skill-deployer"}, "POST", path+"/deployment-check", "", body)
	var check struct {
		Data struct {
			TenantID           string `json:"tenant_id"`
			WorkspaceID        string `json:"workspace_id"`
			CandidateID        string `json:"candidate_id"`
			CandidateHash      string `json:"candidate_hash"`
			NativeSkillHash    string `json:"native_skill_hash"`
			ReleasePackageHash string `json:"release_package_hash"`
		} `json:"data"`
	}
	if err != nil || status != 200 || json.Unmarshal(raw, &check) != nil || check.Data.TenantID != scope.TenantID || check.Data.WorkspaceID != scope.WorkspaceID || check.Data.CandidateID != m.CandidateID || check.Data.CandidateHash != m.CandidateHash || check.Data.NativeSkillHash != skill.Hash || check.Data.ReleasePackageHash != m.ReleasePackageHash {
		return nil, errors.New("flow: current approved release authority unavailable")
	}
	receiptID := "build:" + executable + ":" + m.ReleasePackageHash
	input["kind"], input["receipt_id"], input["build_revision"], input["executable_sha256"] = "deployed", receiptID, "binary-sha256:"+executable, executable
	body, _ = json.Marshal(input)
	dispatcher := CommandDispatcher{DB: db, Engine: engine}
	command, _, err := dispatcher.Enqueue(ctx, CommandInput{Scope: scope, Actor: Actor{Type: "service_principal", ID: "video-skill-deployer"}, Command: "video.skill.deployed", Method: http.MethodPost, Path: path + "/receipts", IdempotencyKey: receiptID, Payload: body})
	if err != nil {
		return nil, err
	}
	command, err = dispatcher.DispatchOne(ctx, command.ID)
	if err != nil {
		return map[string]any{"receipt_status": command.Status, "receipt_operation_id": command.OperationID, "executable_sha256": executable}, err
	}
	return map[string]any{"receipt_status": command.Status, "receipt_operation_id": command.OperationID, "executable_sha256": executable, "release_package_hash": m.ReleasePackageHash, "skill": skill.Ref(), "scope": scope, "deployment_target": "this_running_host", "deployed": command.Status == "dispatched"}, nil
}

func registerVideoReleaseAttestation(api gin.IRouter, db *gorm.DB, cfg Config) {
	api.POST("/internal/flow/video/skills/:id/attest", func(c *gin.Context) {
		claim, ok := internalServiceCtx(c, cfg)
		if !ok {
			return
		}
		if claim.Issuer != cfg.Issuer || claim.Actor.ID != "video-skill-deployer" || !claim.HasScope("intel.skills.deploy") || claim.TenantID == "" || claim.WorkspaceID == "" {
			videoReply(c, 403, "trusted_release_operator_required")
			return
		}
		var input struct {
			Version string `json:"version"`
			Hash    string `json:"hash"`
		}
		if c.ShouldBindJSON(&input) != nil || input.Version == "" || input.Hash == "" {
			videoReply(c, 400, "exact_native_version_required")
			return
		}
		skill, found := FindSkill(c.Param("id"), input.Version)
		if !found || skill.Hash != input.Hash {
			videoReply(c, 409, "native_version_not_in_running_build")
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
		defer cancel()
		result, err := attestVideoRelease(ctx, db, EngineClient{Cfg: cfg}, Scope{TenantID: claim.TenantID, WorkspaceID: claim.WorkspaceID}, skill)
		if err != nil {
			videoReply(c, 409, "current_release_attestation_unavailable")
			return
		}
		if result["deployed"] != true {
			reply(c, 202, result, "running build observed; receipt not confirmed")
			return
		}
		reply(c, 200, result, "running build attested")
	})
}
