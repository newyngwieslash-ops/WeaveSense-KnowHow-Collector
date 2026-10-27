package flow

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"testing"
	"testing/fstest"
	"yingce/backend/internal/model"
)

func videoReleaseFixture(t *testing.T, version string) []byte {
	t.Helper()
	base, ok := FindSkill("video-knowledge-core", "1.0.0")
	if !ok {
		t.Fatal("native base missing")
	}
	skill := Skill{ID: "qa-video-method", Version: version, Name: "Synthetic release", Method: "Evidence only", Steps: []string{"Keep provenance"}, References: []string{}, OutputSchema: json.RawMessage(`{"type":"object"}`)}
	pack := SkillPack{ID: "qa-video-release", Version: version, Name: "Synthetic release", Kind: "video-method", RequiredTools: []string{"intel_read_knowledge"}, MCPRequirements: []string{}, Skills: []Skill{skill}}
	praw, _ := json.Marshal(pack)
	var p any
	_ = json.Unmarshal(praw, &p)
	proposal := map[string]any{"pack": p, "base": base.Ref(), "knowledge_releases": []any{}, "evidence": []any{}, "rule_evidence": []any{}, "frozen_evidence": []any{map[string]any{"quote": "PRIVATE_FROZEN_QUOTE"}}, "eval_spec": map[string]any{"dataset_version": "fixture-only"}}
	ch := videoReleaseHash(proposal)
	evaluation := map[string]any{"passed": true, "candidate_hash": ch, "base_hash": base.Hash, "eval_spec_hash": videoReleaseHash(proposal["eval_spec"])}
	eh := videoReleaseHash(evaluation)
	approval := map[string]any{"actor": "user:synthetic-reviewer", "approved_at": "2026-10-26T00:00:00Z", "candidate_hash": ch, "eval_hash": eh, "reason": "PRIVATE_REVIEW_REASON"}
	manifest := map[string]any{"schema_version": 1, "tenant_id": "tenant", "workspace_id": "workspace", "candidate_id": "candidate-" + version, "candidate_hash": ch, "native_skill_hash": skillHash(skill), "base": base.Ref(), "knowledge_releases": []any{}, "evidence": []any{}, "rule_evidence": []any{}, "eval_report_hash": eh, "approval": approval}
	release := map[string]any{"pack": p, "pack_json": string(praw), "manifest": manifest, "deployment_status": "not_deployed"}
	raw, _ := json.Marshal(map[string]any{"id": "candidate-" + version, "tenant_id": "tenant", "workspace_id": "workspace", "state": "release_package_exported", "candidate_hash": ch, "native_skill_hash": skillHash(skill), "proposal": proposal, "eval_result": evaluation, "approval": approval, "release_package": release})
	raw = bytes.ReplaceAll(raw, []byte(`"tenant_id":"tenant"`), []byte(`"tenant_id":"`+model.PersonalTenantID("u_alice")+`"`))
	raw = bytes.ReplaceAll(raw, []byte(`"workspace_id":"workspace"`), []byte(`"workspace_id":"`+model.PersonalWorkspaceID("u_alice")+`"`))
	return raw
}

func TestVideoReleaseFrozenPackageAndPrivateContentExclusion(t *testing.T) {
	raw := videoReleaseFixture(t, "1.0.0")
	prepared, err := PrepareVideoSkillRelease(raw)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(prepared.ManifestJSON, []byte("PRIVATE_")) || bytes.Contains(prepared.PackJSON, []byte("PRIVATE_")) {
		t.Fatal("private proposal or review leaked into build")
	}
	if prepared.Manifest.Base.ID != "video-knowledge-core" || prepared.Manifest.ReleasePackageHash == "" || prepared.Manifest.Approval.Actor != "user:synthetic-reviewer" {
		t.Fatal("lineage missing", prepared.Manifest)
	}
	for _, field := range []string{"proposal", "eval_result", "approval", "release_package"} {
		var row map[string]any
		_ = json.Unmarshal(raw, &row)
		row[field].(map[string]any)["tampered"] = "yes"
		changed, _ := json.Marshal(row)
		_, err := PrepareVideoSkillRelease(changed)
		// A change solely to an unused release field changes its package hash,
		// which the live deployment-check subsequently refuses. Inner mutable
		// proposal/eval/approval changes must fail immediately.
		if field != "release_package" && err == nil {
			t.Fatalf("%s drift admitted", field)
		}
	}
	if got := string(canonicalVideoRelease(map[string]any{"text": "<中文>\u2028literal\\u2028"})); !strings.Contains(got, "<中文>\u2028literal\\\\u2028") {
		t.Fatal("cross-language canonical JSON", got)
	}
}

func TestVideoReleaseCanonicalHashMatchesJavaScript(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node unavailable for cross-language fixture")
	}
	value := map[string]any{"10": "ten", "2": "two", "𐀀": "supplementary", "\ue000": "bmp", "text": "<中文>😀\u2028\\u2028", "numbers": []any{0.000001, 0.0000001, 1e21, 1.0}, "nested": map[string]any{"z": true, "a": nil}}
	raw, _ := json.Marshal(value)
	cmd := exec.Command(node, "-e", `let s='';process.stdin.on('data',x=>s+=x).on('end',()=>{const c=v=>Array.isArray(v)?v.map(c):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,c(v[k])])):v;process.stdout.write(JSON.stringify(c(JSON.parse(s))))})`)
	cmd.Stdin = bytes.NewReader(raw)
	want, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	if got := canonicalVideoRelease(value); !bytes.Equal(got, want) {
		t.Fatalf("Go/JavaScript canonical mismatch\nGo %s\nJS %s", got, want)
	}
}

func TestVideoReleaseArchivePreservesVersionsAndRejectsOverrides(t *testing.T) {
	fixture := fstest.MapFS{}
	entries, _ := skillFS.ReadDir("skillpacks")
	for _, e := range entries {
		if !e.IsDir() {
			raw, _ := skillFS.ReadFile("skillpacks/" + e.Name())
			fixture["skillpacks/"+e.Name()] = &fstest.MapFile{Data: raw}
		}
	}
	for _, version := range []string{"1.0.0", "1.9.0", "1.10.0"} {
		prepared, err := PrepareVideoSkillRelease(videoReleaseFixture(t, version))
		if err != nil {
			t.Fatal(err)
		}
		name := "skillpacks/releases/" + prepared.Pack.ID + "/" + version
		fixture[name+".json"] = &fstest.MapFile{Data: prepared.PackJSON}
		fixture[name+".manifest.json"] = &fstest.MapFile{Data: prepared.ManifestJSON}
	}
	loaded, err := loadSkillPacksFS(fixture)
	if err != nil {
		t.Fatal(err)
	}
	versions := []string{}
	for _, p := range loaded {
		if p.ID == "qa-video-release" {
			versions = append(versions, p.Version)
		}
	}
	if fmt.Sprint(versions) != "[1.0.0 1.9.0 1.10.0]" {
		t.Fatal("historical version ordering", versions)
	}
	name := "skillpacks/releases/qa-video-release/1.0.0.json"
	old := fixture[name].Data
	fixture[name].Data = bytes.Replace(old, []byte("Evidence only"), []byte("tampered method"), 1)
	if _, err := loadSkillPacksFS(fixture); err == nil {
		t.Fatal("mutated archived version accepted")
	}
	fixture[name].Data = old
	fixture["skillpacks/releases/core/1.0.0.json"] = &fstest.MapFile{Data: fixture["skillpacks/core.json"].Data}
	if _, err := loadSkillPacksFS(fixture); err == nil {
		t.Fatal("reserved root pack overridden")
	}
}
