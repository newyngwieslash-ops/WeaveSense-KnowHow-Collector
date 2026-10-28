package flow

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"yingce/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Skill is a versioned analysis method: steps, references and an output schema.
type Skill struct {
	ID                string                  `json:"id"`
	Version           string                  `json:"version"`
	Name              string                  `json:"name"`
	Method            string                  `json:"method"`
	Steps             []string                `json:"steps"`
	References        []string                `json:"references"`
	OutputSchema      json.RawMessage         `json:"output_schema"`
	Hash              string                  `json:"hash"`
	PackID            string                  `json:"pack_id"`
	KnowledgeSnapshot *VideoKnowledgeSnapshot `json:"knowledge_snapshot,omitempty"`
}

// SkillPack bundles skills; industry packs also carry source templates,
// glossary, report schema and eval samples.
type SkillPack struct {
	ID            string   `json:"id"`
	Version       string   `json:"version"`
	Name          string   `json:"name"`
	Kind          string   `json:"kind,omitempty"`
	RequiredTools []string `json:"required_tools,omitempty"`
	OptionalConns []string `json:"optional_connectors,omitempty"`
	// MCPRequirements names MCP servers the pack needs; empty means none.
	MCPRequirements []string              `json:"mcp_requirements"`
	Skills          []Skill               `json:"skills"`
	SourceTemplates json.RawMessage       `json:"source_templates,omitempty"`
	Glossary        json.RawMessage       `json:"glossary,omitempty"`
	ReportSchema    json.RawMessage       `json:"report_schema,omitempty"`
	EvalSamples     json.RawMessage       `json:"eval_samples,omitempty"`
	Release         *VideoReleaseManifest `json:"release,omitempty"`
}

// SkillRef is the frozen identity recorded on research runs and reports.
type SkillRef struct {
	ID      string `json:"id"`
	Version string `json:"version"`
	Hash    string `json:"hash"`
}

//go:embed skillpacks
var skillFS embed.FS

var (
	packsOnce sync.Once
	packs     []SkillPack
	packsErr  error
)

var ErrSkillNotFound = errors.New("flow: skill not found or not installed")

func skillHash(s Skill) string {
	s.Hash, s.PackID = "", ""
	s.KnowledgeSnapshot = nil
	raw, _ := json.Marshal(s)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// SkillPacks returns the embedded packs with each skill's content hash.
func SkillPacks() ([]SkillPack, error) {
	packsOnce.Do(func() {
		packs, packsErr = loadSkillPacksFS(skillFS)
	})
	return packs, packsErr
}

// FindSkill finds a skill by id and version ("" = latest available).
func FindSkill(id, version string) (Skill, bool) {
	ps, _ := SkillPacks()
	var best Skill
	found := false
	for _, p := range ps {
		for _, s := range p.Skills {
			if s.ID == id && (version == "" || s.Version == version) && (!found || (p.Kind == "video-method" && videoVersionNewer(s.Version, best.Version)) || (p.Kind != "video-method" && s.Version > best.Version)) {
				best, found = s, true
			}
		}
	}
	return best, found
}

// InstallSkill pins a skill version for the workspace (reinstall updates the pin).
func InstallSkill(db *gorm.DB, scope Scope, userID, id, version string) (model.FlowSkillInstall, error) {
	s, ok := FindSkill(id, version)
	if !ok {
		return model.FlowSkillInstall{}, ErrSkillNotFound
	}
	if governedVideoSkill(s) {
		return model.FlowSkillInstall{}, errors.New("flow: video method installation requires the candidate install endpoint and a deployment receipt")
	}
	if err := videoSkillToolsAvailable(db, scope, s); err != nil {
		return model.FlowSkillInstall{}, err
	}
	if err := checkRuntimeVideoSkill(scope, s); err != nil {
		return model.FlowSkillInstall{}, err
	}
	return installSkillPin(db, scope, userID, s)
}

func installSkillPin(db *gorm.DB, scope Scope, userID string, s Skill) (model.FlowSkillInstall, error) {
	row := model.FlowSkillInstall{ID: NewID("sk_"), TenantID: scope.TenantID, WorkspaceID: scope.WorkspaceID, SkillID: s.ID,
		Version: s.Version, Hash: s.Hash, PackID: s.PackID, InstalledBy: userID, UpdatedAt: time.Now().UTC()}
	err := db.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "tenant_id"}, {Name: "workspace_id"}, {Name: "skill_id"}},
		DoUpdates: clause.AssignmentColumns([]string{"version", "hash", "pack_id", "installed_by", "updated_at"})}).Create(&row).Error
	if err != nil {
		return row, err
	}
	// On conflict the database keeps the original primary key; do not let
	// GORM add the just-generated (unused) ID to this canonical pin lookup.
	row = model.FlowSkillInstall{}
	err = db.First(&row, "tenant_id = ? AND workspace_id = ? AND skill_id = ?", scope.TenantID, scope.WorkspaceID, s.ID).Error
	return row, err
}

func ListInstalledSkills(db *gorm.DB, scope Scope) ([]model.FlowSkillInstall, error) {
	var rows []model.FlowSkillInstall
	err := db.Where("tenant_id = ? AND workspace_id = ?", scope.TenantID, scope.WorkspaceID).Order("skill_id").Find(&rows).Error
	return rows, err
}

// LoadSkillForRun returns the installed skill, frozen for runID: the first load
// pins version+hash; later loads in the same run get the pinned version even if
// the workspace installs a different version meanwhile.
func LoadSkillForRun(db *gorm.DB, scope Scope, runID, id string) (Skill, error) {
	resolvePin := func(pin model.FlowSkillRunPin) (Skill, error) {
		s, ok := FindSkill(id, pin.Version)
		if !ok || s.Hash != pin.Hash {
			return Skill{}, errors.New("flow: pinned skill version is no longer available")
		}
		if err := checkRuntimeVideoSkill(scope, s); err != nil {
			return Skill{}, err
		}
		if err := videoSkillToolsAvailable(db, scope, s); err != nil {
			return Skill{}, err
		}
		return withVideoKnowledgeSnapshot(scope, runID, s)
	}
	if runID != "" {
		var pin model.FlowSkillRunPin
		err := db.First(&pin, "run_id = ? AND skill_id = ? AND tenant_id = ?", runID, id, scope.TenantID).Error
		if err == nil {
			return resolvePin(pin)
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return Skill{}, err
		}
	}
	var inst model.FlowSkillInstall
	if err := db.First(&inst, "tenant_id = ? AND workspace_id = ? AND skill_id = ?", scope.TenantID, scope.WorkspaceID, id).Error; err != nil {
		return Skill{}, ErrSkillNotFound
	}
	s, ok := FindSkill(id, inst.Version)
	if !ok || s.Hash != inst.Hash {
		return Skill{}, ErrSkillNotFound
	}
	if err := checkRuntimeVideoSkill(scope, s); err != nil {
		return Skill{}, err
	}
	if runID != "" {
		if err := db.Clauses(clause.OnConflict{DoNothing: true}).Create(&model.FlowSkillRunPin{RunID: runID, SkillID: id, TenantID: scope.TenantID, Version: s.Version, Hash: s.Hash, CreatedAt: time.Now().UTC()}).Error; err != nil {
			return Skill{}, err
		}
		// A concurrent first load may have won with a different installed version.
		// Read that durable pin once; a failed insert or scope collision must not
		// recurse forever or silently use this caller's unpersisted version.
		var pin model.FlowSkillRunPin
		if err := db.First(&pin, "run_id = ? AND skill_id = ? AND tenant_id = ?", runID, id, scope.TenantID).Error; err != nil {
			return Skill{}, err
		}
		return resolvePin(pin)
	}
	return s, nil
}

func (s Skill) Ref() SkillRef { return SkillRef{ID: s.ID, Version: s.Version, Hash: s.Hash} }
