package flow

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// This is non-content build lineage, NOT an approval or deployment authority.
// Runtime deployment-check revalidates the private frozen proposal in Loom.
type VideoReleaseManifest struct {
	SchemaVersion      int      `json:"schema_version"`
	TenantID           string   `json:"tenant_id"`
	WorkspaceID        string   `json:"workspace_id"`
	CandidateID        string   `json:"candidate_id"`
	CandidateHash      string   `json:"candidate_hash"`
	NativeSkillHash    string   `json:"native_skill_hash"`
	ReleasePackageHash string   `json:"release_package_hash"`
	PackSHA256         string   `json:"pack_sha256"`
	EvalReportHash     string   `json:"eval_report_hash"`
	Base               SkillRef `json:"base"`
	Approval           struct {
		Actor         string `json:"actor"`
		ApprovedAt    string `json:"approved_at"`
		CandidateHash string `json:"candidate_hash"`
		EvalHash      string `json:"eval_hash"`
	} `json:"approval"`
	Lineage json.RawMessage `json:"lineage,omitempty"`
}

var videoReleaseID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$`)
var videoSHA = regexp.MustCompile(`^[a-f0-9]{64}$`)
var videoReleaseVersion = regexp.MustCompile(`^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$`)

func skillPackContains(pack SkillPack, skill Skill) bool {
	for _, s := range pack.Skills {
		if s.ID == skill.ID && s.Version == skill.Version && s.Hash == skill.Hash {
			return true
		}
	}
	return false
}

func skillPackFor(skill Skill) (SkillPack, bool) {
	all, err := SkillPacks()
	if err != nil {
		return SkillPack{}, false
	}
	for _, pack := range all {
		if pack.ID == skill.PackID && skillPackContains(pack, skill) {
			return pack, true
		}
	}
	return SkillPack{}, false
}

func skillVisibleInScope(scope Scope, skill Skill) bool {
	p, ok := skillPackFor(skill)
	return ok && (p.Release == nil || (p.Release.TenantID == scope.TenantID && p.Release.WorkspaceID == scope.WorkspaceID))
}

func skillPacksForScope(scope Scope) ([]SkillPack, error) {
	all, err := SkillPacks()
	if err != nil {
		return nil, err
	}
	result := make([]SkillPack, 0, len(all))
	for _, p := range all {
		if p.Release == nil || (p.Release.TenantID == scope.TenantID && p.Release.WorkspaceID == scope.WorkspaceID) {
			result = append(result, p)
		}
	}
	return result, nil
}

func videoVersionNewer(a, b string) bool {
	if !videoReleaseVersion.MatchString(a) || !videoReleaseVersion.MatchString(b) {
		return a > b
	}
	aa, bb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < 3; i++ {
		x, _ := strconv.Atoi(aa[i])
		y, _ := strconv.Atoi(bb[i])
		if x != y {
			return x > y
		}
	}
	return false
}

// Archive entries are immutable source files compiled with the application;
// there is no writable dynamic registry or downloaded executable method path.
func loadSkillPacksFS(source fs.FS) ([]SkillPack, error) {
	var result []SkillPack
	reservedPacks, reservedSkills := map[string]bool{}, map[string]bool{}
	seenPacks, seenSkills := map[string]string{}, map[string]string{}
	var filenames []string
	err := fs.WalkDir(source, "skillpacks", func(name string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && strings.HasSuffix(name, ".json") && !strings.HasSuffix(name, ".manifest.json") {
			filenames = append(filenames, name)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	// Root (legacy) IDs are reserved irrespective of archive traversal order.
	sort.Slice(filenames, func(i, j int) bool {
		di, dj := strings.Count(filenames[i], "/"), strings.Count(filenames[j], "/")
		if di != dj {
			return di < dj
		}
		return filenames[i] < filenames[j]
	})
	for _, name := range filenames {
		raw, err := fs.ReadFile(source, name)
		if err != nil {
			return nil, err
		}
		var p SkillPack
		if err = json.Unmarshal(bytes.ReplaceAll(raw, []byte("\r\n"), []byte("\n")), &p); err != nil {
			return nil, err
		}
		p.Release = nil
		archive := strings.HasPrefix(name, "skillpacks/releases/")
		if !archive && path.Dir(name) != "skillpacks" {
			return nil, fmt.Errorf("flow: unexpected skill source %s", name)
		}
		if p.ID == "" || p.Version == "" || len(p.Skills) == 0 {
			return nil, fmt.Errorf("flow: invalid skill pack %s", name)
		}
		for i := range p.Skills {
			p.Skills[i].PackID = p.ID
			p.Skills[i].Hash = skillHash(p.Skills[i])
		}
		if archive {
			if !videoReleaseID.MatchString(p.ID) || !videoReleaseVersion.MatchString(p.Version) || p.Kind != "video-method" || len(p.Skills) != 1 || p.Version != p.Skills[0].Version || reservedPacks[p.ID] || reservedSkills[p.Skills[0].ID] || name != "skillpacks/releases/"+p.ID+"/"+p.Version+".json" {
				return nil, fmt.Errorf("flow: invalid or reserved native release %s", name)
			}
			manifest, err := fs.ReadFile(source, strings.TrimSuffix(name, ".json")+".manifest.json")
			if err != nil {
				return nil, err
			}
			var m VideoReleaseManifest
			if err = json.Unmarshal(manifest, &m); err != nil {
				return nil, err
			}
			sum := sha256.Sum256(raw)
			if m.SchemaVersion != 1 || m.TenantID == "" || m.WorkspaceID == "" || m.CandidateID == "" || !videoSHA.MatchString(m.CandidateHash) || !videoSHA.MatchString(m.ReleasePackageHash) || m.PackSHA256 != hex.EncodeToString(sum[:]) || m.NativeSkillHash != p.Skills[0].Hash || !videoSHA.MatchString(m.EvalReportHash) || m.Approval.CandidateHash != m.CandidateHash || m.Approval.EvalHash != m.EvalReportHash || !strings.HasPrefix(m.Approval.Actor, "user:") || m.Approval.ApprovedAt == "" {
				return nil, fmt.Errorf("flow: invalid native release lineage %s", name)
			}
			p.Release = &m
		} else {
			reservedPacks[p.ID] = true
			for _, s := range p.Skills {
				reservedSkills[s.ID] = true
			}
		}
		packKey := p.ID + "@" + p.Version
		if _, ok := seenPacks[packKey]; ok {
			return nil, fmt.Errorf("flow: duplicate pack version %s", packKey)
		}
		seenPacks[packKey] = name
		for _, s := range p.Skills {
			k := s.ID + "@" + s.Version
			if old, ok := seenSkills[k]; ok {
				return nil, fmt.Errorf("flow: duplicate/conflicting native skill %s (%s)", k, old)
			}
			seenSkills[k] = s.Hash
		}
		result = append(result, p)
	}
	for _, p := range result {
		if p.Release != nil {
			base := p.Release.Base
			if seenSkills[base.ID+"@"+base.Version] != base.Hash || base.Hash == "" {
				return nil, fmt.Errorf("flow: frozen native base unavailable %s", p.ID)
			}
			for _, other := range result {
				if other.ID == p.ID && other.Release != nil && (other.Release.TenantID != p.Release.TenantID || other.Release.WorkspaceID != p.Release.WorkspaceID) {
					return nil, fmt.Errorf("flow: native pack scope conflict %s", p.ID)
				}
			}
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].ID == result[j].ID {
			return videoVersionNewer(result[j].Version, result[i].Version)
		}
		return result[i].ID < result[j].ID
	})
	return result, nil
}
