package flow

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"yingce/backend/internal/model"
)

func TestVideoReleaseIsolatedBuildAndRunningRegistry(t *testing.T) {
	if os.Getenv("FLOW_VIDEO_RELEASE_BUILD_TEST") != "1" {
		t.Skip("opt-in isolated synthetic build, no deployment")
	}
	root := t.TempDir()
	source, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	copyFile := func(from, to string) error {
		data, e := os.ReadFile(from)
		if e != nil {
			return e
		}
		if e = os.MkdirAll(filepath.Dir(to), 0755); e != nil {
			return e
		}
		return os.WriteFile(to, data, 0644)
	}
	for _, folder := range []string{"internal", "cmd/video-skill-release"} {
		err = filepath.WalkDir(filepath.Join(source, folder), func(name string, d fs.DirEntry, e error) error {
			if e != nil {
				return e
			}
			if d.IsDir() {
				return nil
			}
			if d.Type()&os.ModeSymlink != 0 {
				return nil
			}
			rel, e := filepath.Rel(source, name)
			if e != nil {
				return e
			}
			return copyFile(name, filepath.Join(root, rel))
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"go.mod", "go.sum"} {
		if err = copyFile(filepath.Join(source, name), filepath.Join(root, name)); err != nil {
			t.Fatal(err)
		}
	}
	archive := filepath.Join(root, "internal/flow/skillpacks/releases")
	if err = os.MkdirAll(archive, 0755); err != nil {
		t.Fatal(err)
	}
	goBinary := filepath.Join(runtime.GOROOT(), "bin/go")
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command(goBinary, args...)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GOMAXPROCS=2")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("isolated command %v: %v\n%s", args, err, out)
		}
		t.Log(strings.TrimSpace(string(out)))
	}
	for _, version := range []string{"1.0.0", "2.0.0"} {
		input := filepath.Join(root, "authorized-fixture-"+version+".json")
		if err = os.WriteFile(input, videoReleaseFixture(t, version), 0600); err != nil {
			t.Fatal(err)
		}
		run("run", "-p", "2", "./cmd/video-skill-release", "--input", input, "--archive-root", archive)
		run("run", "-p", "2", "./cmd/video-skill-release", "--input", input, "--check")
	}
	binary := filepath.Join(root, "release-host.test")
	run("test", "-p", "2", "-c", "-o", binary, "./internal/flow")
	child := exec.Command(binary, "-test.run", "^TestVideoReleaseCompiledChild$", "-test.v")
	child.Dir = filepath.Join(root, "internal/flow")
	child.Env = append(os.Environ(), "FLOW_VIDEO_RELEASE_CHILD=1")
	output, err := child.CombinedOutput()
	if err != nil {
		t.Fatalf("compiled runtime: %v\n%s", err, output)
	}
	t.Log(string(output))
}

func TestVideoReleaseCompiledChild(t *testing.T) {
	if os.Getenv("FLOW_VIDEO_RELEASE_CHILD") != "1" {
		t.Skip("only run inside isolated built archive")
	}
	db := testDB(t)
	scope, err := ResolveScope(db, "u_alice", "")
	if err != nil {
		t.Fatal(err)
	}
	v1, ok1 := FindSkill("qa-video-method", "1.0.0")
	v2, ok2 := FindSkill("qa-video-method", "2.0.0")
	latest, _ := FindSkill("qa-video-method", "")
	if !ok1 || !ok2 || latest.Hash != v2.Hash || v1.Hash == v2.Hash {
		t.Fatal("built historical versions unavailable")
	}
	deployed := map[string]bool{}
	revoked := false
	receipts := 0
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claim, e := Verify(key, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), "loom-engine", time.Now())
		if e != nil || claim.TenantID != scope.TenantID || claim.WorkspaceID != scope.WorkspaceID {
			w.WriteHeader(403)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		version, _ := body["version"].(string)
		skill, found := FindSkill("qa-video-method", version)
		pack, _ := skillPackFor(skill)
		if r.URL.Path == "/v1/knowledge/snapshots" {
			method := body["method"].(map[string]any)
			_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"id": "snapshot-" + body["run_id"].(string), "run_id": body["run_id"], "method": method, "content_hash": strings.Repeat("a", 64)}})
			return
		}
		if !found || pack.Release == nil || revoked {
			w.WriteHeader(409)
			return
		}
		m := pack.Release
		switch {
		case strings.HasSuffix(r.URL.Path, "/deployment-check"):
			if claim.Actor.ID != "video-skill-deployer" || !claim.HasScope("intel.skills.deploy") {
				w.WriteHeader(403)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"tenant_id": scope.TenantID, "workspace_id": scope.WorkspaceID, "candidate_id": m.CandidateID, "candidate_hash": m.CandidateHash, "native_skill_hash": skill.Hash, "release_package_hash": m.ReleasePackageHash}})
		case strings.HasSuffix(r.URL.Path, "/receipts"):
			if body["kind"] == "deployed" {
				actual, _ := videoExecutableSHA256()
				if body["executable_sha256"] != actual || body["release_package_hash"] != m.ReleasePackageHash || claim.Actor.ID != "video-skill-deployer" {
					t.Error("false build receipt", body)
					w.WriteHeader(409)
					return
				}
				deployed[version] = true
				receipts++
			} else if !deployed[version] || claim.Actor.ID != "video-skill-installer" {
				w.WriteHeader(409)
				return
			}
			_, _ = w.Write([]byte(`{"data":{"ok":true}}`))
		case strings.HasSuffix(r.URL.Path, "/check-pin"):
			_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"available": deployed[version], "candidate_id": m.CandidateID, "candidate_hash": m.CandidateHash, "native_skill_hash": skill.Hash}})
		default:
			w.WriteHeader(404)
		}
	}))
	defer engine.Close()
	cfg := Config{EngineURL: engine.URL, SigningKey: key, Issuer: "flow-platform", Audience: "loom-engine", TTL: MaxTokenTTL}
	t.Setenv("LOOM_ENGINE_URL", engine.URL)
	t.Setenv("FLOW_INTERNAL_JWT_SIGNING_KEY", string(key))
	t.Setenv("FLOW_INTERNAL_JWT_ISSUER", "flow-platform")
	t.Setenv("FLOW_INTERNAL_JWT_AUDIENCE", "loom-engine")
	router := gin.New()
	registerVideoReleaseAttestation(router.Group("/api"), db, cfg)
	registerVideoSkillInstall(router.Group("/api/intelligence"), db, EngineClient{Cfg: cfg}, func(*gin.Context) (Scope, *model.User, bool) { return scope, &model.User{ID: "u_alice"}, true })
	invoke := func(path string, body any, token string, idem string, want int) {
		t.Helper()
		raw, _ := json.Marshal(body)
		req := httptest.NewRequest("POST", path, bytes.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Idempotency-Key", idem)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		if out.Code != want {
			t.Fatalf("%s status%d want%d %s", path, out.Code, want, out.Body.String())
		}
	}
	token, _ := Sign(key, ExecutionContext{Issuer: "flow-platform", Audience: "flow-platform", TenantID: scope.TenantID, WorkspaceID: scope.WorkspaceID, Actor: Actor{Type: "service_principal", ID: "video-skill-deployer"}, Scopes: []string{"intel.skills.deploy"}}, time.Now(), time.Minute)
	install := func(skill Skill, current, key string, want int) {
		p, _ := skillPackFor(skill)
		invoke("/api/intelligence/video/skill-candidates/"+p.Release.CandidateID+"/install", map[string]any{"skill_id": skill.ID, "version": skill.Version, "hash": skill.Hash, "expected_hash": p.Release.CandidateHash, "expected_install_hash": current}, "", key, want)
	}
	install(v1, "", "before-build-receipt", 409)
	for _, skill := range []Skill{v1, v2} {
		invoke("/api/internal/flow/video/skills/"+skill.ID+"/attest", map[string]any{"version": skill.Version, "hash": skill.Hash}, token, "", 200)
	}
	install(v1, "", "install-v1", 200)
	first, err := LoadSkillForRun(db, scope, "old-run", v1.ID)
	if err != nil || first.Hash != v1.Hash {
		t.Fatal("old run pin", err)
	}
	install(v2, "", "missing-cas", 409)
	install(v2, v1.Hash, "install-v2", 200)
	old, err := LoadSkillForRun(db, scope, "old-run", v1.ID)
	if err != nil || old.Hash != v1.Hash {
		t.Fatal("update changed old run", err)
	}
	install(v1, v1.Hash, "stale-rollback", 409)
	install(v1, v2.Hash, "rollback-v1", 200)
	if _, err := InstallSkill(db, scope, "u_alice", v1.ID, v1.Version); err == nil {
		t.Fatal("generic installer bypass")
	}
	if visible, _ := skillPacksForScope(Scope{TenantID: "foreign", WorkspaceID: "foreign"}); len(visible) != 4 {
		t.Fatal("private archived method leaked", len(visible))
	}
	revoked = true
	if _, err := LoadSkillForRun(db, scope, "old-run", v1.ID); err == nil {
		t.Fatal("old pin bypassed current revocation")
	}
	if receipts != 2 {
		t.Fatal("deployment receipts", receipts)
	}
	sha, _ := videoExecutableSHA256()
	t.Logf("synthetic compiled registry: versions=2 actual_executable_sha256=%s deployment_receipts=%d CAS_install_and_rollback=true old_run_preserved=true current_revocation_denied=true", sha, receipts)
}
