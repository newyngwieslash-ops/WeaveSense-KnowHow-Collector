package flow

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

// VideoReleasePackage is the only output permitted from private candidate
// verification. Proposal quotes, evaluation outputs and review prose are not
// retained in source control or the compiled registry.
type VideoReleasePackage struct {
	Pack         SkillPack
	PackJSON     []byte
	Manifest     VideoReleaseManifest
	ManifestJSON []byte
}

func canonicalVideoRelease(value any) []byte {
	// Normalize structs and RawMessages too: Loom recursively sorts EVERY
	// object, not just maps supplied by the JSON decoder.
	normalizedJSON, _ := json.Marshal(value)
	var normalizedValue any
	_ = json.Unmarshal(normalizedJSON, &normalizedValue)
	var out bytes.Buffer
	indexKey := func(s string) (uint64, bool) {
		n, e := strconv.ParseUint(s, 10, 32)
		return n, e == nil && n < 4294967295 && strconv.FormatUint(n, 10) == s
	}
	var write func(any)
	write = func(value any) {
		switch value := value.(type) {
		case map[string]any:
			keys := make([]string, 0, len(value))
			for k := range value {
				keys = append(keys, k)
			}
			sort.Slice(keys, func(i, j int) bool {
				a, ai := indexKey(keys[i])
				b, bi := indexKey(keys[j])
				if ai || bi {
					if ai && bi {
						return a < b
					}
					return ai
				}
				x, y := utf16.Encode([]rune(keys[i])), utf16.Encode([]rune(keys[j]))
				for n := 0; n < len(x) && n < len(y); n++ {
					if x[n] != y[n] {
						return x[n] < y[n]
					}
				}
				return len(x) < len(y)
			})
			out.WriteByte('{')
			for i, k := range keys {
				if i > 0 {
					out.WriteByte(',')
				}
				write(k)
				out.WriteByte(':')
				write(value[k])
			}
			out.WriteByte('}')
		case []any:
			out.WriteByte('[')
			for i, item := range value {
				if i > 0 {
					out.WriteByte(',')
				}
				write(item)
			}
			out.WriteByte(']')
		default:
			var leaf bytes.Buffer
			encoder := json.NewEncoder(&leaf)
			encoder.SetEscapeHTML(false)
			_ = encoder.Encode(value)
			out.Write(bytes.TrimSuffix(leaf.Bytes(), []byte("\n")))
		}
	}
	write(normalizedValue)
	raw := out.Bytes()
	// JSON.stringify preserves U+2028/U+2029; Go escapes them even without
	// HTML escaping. Only unescape an actual JSON escape, not a literal slash.
	var normalized bytes.Buffer
	for i := 0; i < len(raw); i++ {
		if raw[i] == '\\' && i+5 < len(raw) && (string(raw[i:i+6]) == `\u2028` || string(raw[i:i+6]) == `\u2029`) {
			count := 0
			for j := i - 1; j >= 0 && raw[j] == '\\'; j-- {
				count++
			}
			if count%2 == 0 {
				if raw[i+5] == '8' {
					normalized.WriteString("\u2028")
				} else {
					normalized.WriteString("\u2029")
				}
				i += 5
				continue
			}
		}
		normalized.WriteByte(raw[i])
	}
	return normalized.Bytes()
}

func videoReleaseHash(value any) string {
	sum := sha256.Sum256(canonicalVideoRelease(value))
	return hex.EncodeToString(sum[:])
}

// PrepareVideoSkillRelease validates a complete authorized Loom export against
// the current compiled native base. It neither downloads a candidate nor emits
// a deployed receipt. Callers must write files exclusively/immutably and then
// build/start the host before asking that host to attest its embedded registry.
func PrepareVideoSkillRelease(raw []byte) (VideoReleasePackage, error) {
	var out VideoReleasePackage
	if len(raw) > 16<<20 {
		return out, errors.New("flow: release export exceeds 16 MiB")
	}
	var row map[string]any
	if json.Unmarshal(raw, &row) != nil {
		return out, ErrInvalid
	}
	if data, ok := row["data"].(map[string]any); ok {
		row = data
	}
	object := func(v any) map[string]any { m, _ := v.(map[string]any); return m }
	text := func(m map[string]any, k string) string { v, _ := m[k].(string); return v }
	proposal, evaluation, approval, release := object(row["proposal"]), object(row["eval_result"]), object(row["approval"]), object(row["release_package"])
	manifest := object(release["manifest"])
	state := text(row, "state")
	if proposal == nil || evaluation == nil || approval == nil || manifest == nil || (state != "release_package_exported" && state != "deployed" && state != "workspace_installed") || evaluation["passed"] != true {
		return out, errors.New("flow: approved evaluated export required")
	}
	candidateHash, evalHash := videoReleaseHash(proposal), videoReleaseHash(evaluation)
	if text(row, "candidate_hash") != candidateHash || text(approval, "candidate_hash") != candidateHash || text(approval, "eval_hash") != evalHash || text(manifest, "candidate_hash") != candidateHash || text(manifest, "eval_report_hash") != evalHash || videoReleaseHash(manifest["approval"]) != videoReleaseHash(approval) {
		return out, errors.New("flow: frozen candidate/evaluation/approval mismatch")
	}
	if !strings.HasPrefix(text(approval, "actor"), "user:") || text(approval, "approved_at") == "" {
		return out, errors.New("flow: human release approval required")
	}
	for _, k := range []string{"base", "knowledge_releases", "evidence", "rule_evidence"} {
		if videoReleaseHash(manifest[k]) != videoReleaseHash(proposal[k]) {
			return out, fmt.Errorf("flow: frozen release %s mismatch", k)
		}
	}
	if videoReleaseHash(release["pack"]) != videoReleaseHash(proposal["pack"]) {
		return out, errors.New("flow: candidate pack mismatch")
	}
	packJSON := text(release, "pack_json")
	var packValue any
	if packJSON == "" || json.Unmarshal([]byte(packJSON), &packValue) != nil || videoReleaseHash(packValue) != videoReleaseHash(release["pack"]) || json.Unmarshal([]byte(packJSON), &out.Pack) != nil {
		return out, errors.New("flow: native pack JSON mismatch")
	}
	p := out.Pack
	if p.Kind != "video-method" || !videoReleaseID.MatchString(p.ID) || !videoReleaseVersion.MatchString(p.Version) || len(p.Skills) != 1 || p.Skills[0].Version != p.Version || p.Release != nil {
		return out, errors.New("flow: invalid native archive pack")
	}
	nativeHash := skillHash(p.Skills[0])
	if nativeHash != text(row, "native_skill_hash") || nativeHash != text(manifest, "native_skill_hash") {
		return out, errors.New("flow: native skill hash mismatch")
	}
	baseRaw, _ := json.Marshal(proposal["base"])
	var base SkillRef
	if json.Unmarshal(baseRaw, &base) != nil {
		return out, ErrInvalid
	}
	known, ok := FindSkill(base.ID, base.Version)
	if !ok || known.Hash != base.Hash {
		return out, errors.New("flow: frozen base not in this build")
	}
	ps, err := SkillPacks()
	if err != nil {
		return out, err
	}
	for _, existing := range ps {
		if existing.Release == nil && (existing.ID == p.ID) {
			return out, errors.New("flow: reserved native pack ID")
		}
		for _, s := range existing.Skills {
			if s.ID == p.Skills[0].ID && (existing.Release == nil || (s.Version == p.Version && s.Hash != nativeHash)) {
				return out, errors.New("flow: reserved/conflicting native skill identity")
			}
		}
	}
	m := VideoReleaseManifest{SchemaVersion: 1, TenantID: text(manifest, "tenant_id"), WorkspaceID: text(manifest, "workspace_id"), CandidateID: text(manifest, "candidate_id"), CandidateHash: candidateHash, NativeSkillHash: nativeHash, ReleasePackageHash: videoReleaseHash(release), EvalReportHash: evalHash, Base: base}
	if m.TenantID == "" || m.WorkspaceID == "" || m.CandidateID == "" || text(row, "id") != m.CandidateID || (text(row, "tenant_id") != "" && text(row, "tenant_id") != m.TenantID) || (text(row, "workspace_id") != "" && text(row, "workspace_id") != m.WorkspaceID) {
		return out, errors.New("flow: release scope mismatch")
	}
	m.Approval.Actor, m.Approval.ApprovedAt, m.Approval.CandidateHash, m.Approval.EvalHash = text(approval, "actor"), text(approval, "approved_at"), candidateHash, evalHash
	m.Lineage = canonicalVideoRelease(map[string]string{"knowledge_releases_hash": videoReleaseHash(proposal["knowledge_releases"]), "evidence_hash": videoReleaseHash(proposal["evidence"]), "rule_evidence_hash": videoReleaseHash(proposal["rule_evidence"]), "eval_spec_hash": videoReleaseHash(proposal["eval_spec"])})
	out.PackJSON = append([]byte(packJSON), '\n')
	sum := sha256.Sum256(out.PackJSON)
	m.PackSHA256 = hex.EncodeToString(sum[:])
	out.Manifest = m
	out.ManifestJSON, err = json.MarshalIndent(m, "", "  ")
	if err != nil {
		return out, err
	}
	out.ManifestJSON = append(out.ManifestJSON, '\n')
	return out, nil
}
