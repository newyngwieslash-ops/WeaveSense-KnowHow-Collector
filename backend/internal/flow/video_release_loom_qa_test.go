package flow

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"yingce/backend/internal/model"
)

// An independently exported real Loom candidate crosses the actual CLI/embed
// compiler and running host. Evaluator/reviewer/evidence remain labelled fixtures.
func TestVideoQALoomExportBuildAndRunningRegistry(t *testing.T) {
	if os.Getenv("FLOW_VIDEO_RELEASE_BUILD_TEST") != "1" {
		t.Skip("opt-in actual isolated compiler/domain integration")
	}
	db := testDB(t)
	scope, err := ResolveScope(db, "u_alice", "")
	if err != nil {
		t.Fatal(err)
	}
	cfg := Config{SigningKey: key, Issuer: "flow-platform", Audience: "loom-engine", TTL: MaxTokenTTL}
	r := gin.New()
	registerVideoModelRoutes(r.Group("/api"), db, cfg, nil)
	bootstrap := httptest.NewServer(r)
	defer bootstrap.Close()
	root := t.TempDir()
	data := filepath.Join(root, "loom-data")
	if err := os.Mkdir(data, 0700); err != nil {
		t.Fatal(err)
	}
	loom, _ := filepath.Abs("../../../services/loom-engine")
	scopeJSON, _ := json.Marshal(map[string]string{"tenant_id": scope.TenantID, "workspace_id": scope.WorkspaceID})
	env := append(os.Environ(), "VIDEO_QA_RELEASE_DIR="+data, "VIDEO_QA_SIGNING_KEY="+string(key), "VIDEO_QA_SCOPE="+string(scopeJSON), "VIDEO_QA_HOST_URL="+bootstrap.URL, "FLOW_VIDEO_ENABLED=true")
	export := exec.Command("node", "--experimental-strip-types", "validation/video-knowledge/release-loom-qa.ts", "export")
	export.Dir, export.Env = loom, env
	if out, err := export.CombinedOutput(); err != nil {
		t.Fatalf("actual Loom export: %v\n%s", err, out)
	}
	source, _ := filepath.Abs("../..")
	build := filepath.Join(root, "backend")
	copyFile := func(from, to string) error {
		b, e := os.ReadFile(from)
		if e != nil {
			return e
		}
		if e = os.MkdirAll(filepath.Dir(to), 0755); e != nil {
			return e
		}
		return os.WriteFile(to, b, 0644)
	}
	for _, folder := range []string{"internal", "cmd/video-skill-release"} {
		err = filepath.WalkDir(filepath.Join(source, folder), func(name string, d fs.DirEntry, e error) error {
			if e != nil {
				return e
			}
			if d.IsDir() || d.Type()&os.ModeSymlink != 0 {
				return nil
			}
			rel, e := filepath.Rel(source, name)
			if e != nil {
				return e
			}
			return copyFile(name, filepath.Join(build, rel))
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"go.mod", "go.sum"} {
		if err := copyFile(filepath.Join(source, name), filepath.Join(build, name)); err != nil {
			t.Fatal(err)
		}
	}
	goBin := filepath.Join(runtime.GOROOT(), "bin/go")
	run := func(args ...string) {
		t.Helper()
		c := exec.Command(goBin, args...)
		c.Dir = build
		c.Env = append(os.Environ(), "GOMAXPROCS=2")
		if out, err := c.CombinedOutput(); err != nil {
			t.Fatalf("actual compiler %v: %v\n%s", args, err, out)
		}
	}
	archive := filepath.Join(build, "internal/flow/skillpacks/releases")
	if err := os.MkdirAll(archive, 0755); err != nil {
		t.Fatal(err)
	}
	run("run", "-p", "2", "./cmd/video-skill-release", "--input", filepath.Join(data, "candidate.json"), "--archive-root", archive)
	binary := filepath.Join(root, "actual-loom-release.test")
	run("test", "-p", "2", "-c", "-o", binary, "./internal/flow")
	child := exec.Command(binary, "-test.run", "^TestVideoQALoomReleaseCompiledChild$", "-test.v")
	child.Dir = filepath.Join(build, "internal/flow")
	child.Env = append(env, "FLOW_VIDEO_QA_LOOM_RELEASE_CHILD=1", "VIDEO_QA_LOOM_DIRECTORY="+loom)
	if out, err := child.CombinedOutput(); err != nil {
		t.Fatalf("compiled real domain runtime: %v\n%s", err, out)
	} else {
		t.Log(string(out))
	}
}

func TestVideoQALoomReleaseCompiledChild(t *testing.T) {
	if os.Getenv("FLOW_VIDEO_QA_LOOM_RELEASE_CHILD") != "1" {
		t.Skip("only runs in isolated actual-domain archive")
	}
	db := testDB(t)
	scope, err := ResolveScope(db, "u_alice", "")
	if err != nil {
		t.Fatal(err)
	}
	skill, ok := FindSkill("qa-loom-method", "1.0.0")
	if !ok {
		t.Fatal("real domain export absent from executing registry")
	}
	pack, ok := skillPackFor(skill)
	if !ok || pack.Release == nil {
		t.Fatal("compiled lineage absent")
	}
	var router atomic.Pointer[gin.Engine]
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if h := router.Load(); h != nil {
			h.ServeHTTP(w, r)
		} else {
			w.WriteHeader(503)
		}
	}))
	defer host.Close()
	cfg := Config{SigningKey: key, Issuer: "flow-platform", Audience: "loom-engine", TTL: MaxTokenTTL}
	bootstrap := gin.New()
	registerVideoModelRoutes(bootstrap.Group("/api"), db, cfg, nil)
	router.Store(bootstrap)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", "--experimental-strip-types", "validation/video-knowledge/release-loom-qa.ts", "serve")
	cmd.Dir = os.Getenv("VIDEO_QA_LOOM_DIRECTORY")
	cmd.Env = append(os.Environ(), "VIDEO_QA_HOST_URL="+host.URL)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Signal(os.Interrupt); _ = cmd.Wait() })
	lines := bufio.NewScanner(stdout)
	if !lines.Scan() || !strings.HasPrefix(lines.Text(), "http://127.0.0.1:") {
		t.Fatalf("durable Loom reopen failed %s", lines.Text())
	}
	cfg.EngineURL = lines.Text()
	t.Setenv("LOOM_ENGINE_URL", cfg.EngineURL)
	t.Setenv("FLOW_INTERNAL_JWT_SIGNING_KEY", string(key))
	t.Setenv("FLOW_INTERNAL_JWT_ISSUER", "flow-platform")
	t.Setenv("FLOW_INTERNAL_JWT_AUDIENCE", "loom-engine")
	r := gin.New()
	registerVideoModelRoutes(r.Group("/api"), db, cfg, nil)
	registerVideoSkillInstall(r.Group("/api/intelligence"), db, EngineClient{Cfg: cfg}, func(*gin.Context) (Scope, *model.User, bool) { return scope, &model.User{ID: "u_alice"}, true })
	router.Store(r)
	invoke := func(path string, body any, token, idem string, want int) {
		t.Helper()
		raw, _ := json.Marshal(body)
		request, _ := http.NewRequest("POST", host.URL+path, bytes.NewReader(raw))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Idempotency-Key", idem)
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response, err := host.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var envelope any
		_ = json.NewDecoder(response.Body).Decode(&envelope)
		if response.StatusCode != want {
			t.Fatalf("%s status%d want%d %#v", path, response.StatusCode, want, envelope)
		}
	}
	install := map[string]any{"skill_id": skill.ID, "version": skill.Version, "hash": skill.Hash, "expected_hash": pack.Release.CandidateHash, "expected_install_hash": ""}
	installPath := "/api/intelligence/video/skill-candidates/" + pack.Release.CandidateID + "/install"
	invoke(installPath, install, "", "before-attestation", 409)
	// Same deployment scope is insufficient without the exact trusted service actor.
	wrongToken, _ := Sign(key, ExecutionContext{Issuer: "flow-platform", Audience: "loom-engine", TenantID: scope.TenantID, WorkspaceID: scope.WorkspaceID, Actor: Actor{Type: "service_principal", ID: "wrong-receipt-writer"}, Scopes: []string{"intel.skills.deploy"}}, time.Now(), time.Minute)
	wrongRequest, _ := http.NewRequest("POST", cfg.EngineURL+"/v1/video/skill-candidates/"+pack.Release.CandidateID+"/receipts", strings.NewReader(`{"kind":"deployed"}`))
	wrongRequest.Header.Set("Authorization", "Bearer "+wrongToken)
	wrongRequest.Header.Set("X-Idempotency-Key", "wrong-service-receipt")
	wrongResponse, err := http.DefaultClient.Do(wrongRequest)
	if err != nil {
		t.Fatal(err)
	}
	_ = wrongResponse.Body.Close()
	if wrongResponse.StatusCode != 403 {
		t.Fatalf("wrong trusted receipt actor status %d", wrongResponse.StatusCode)
	}
	token, _ := Sign(key, ExecutionContext{Issuer: "flow-platform", Audience: "flow-platform", TenantID: scope.TenantID, WorkspaceID: scope.WorkspaceID, Actor: Actor{Type: "service_principal", ID: "video-skill-deployer"}, Scopes: []string{"intel.skills.deploy"}}, time.Now(), time.Minute)
	invoke("/api/internal/flow/video/skills/"+skill.ID+"/attest", map[string]any{"version": skill.Version, "hash": skill.Hash}, token, "", 200)
	invoke(installPath, install, "", "actual-domain-install", 200)
	pinned, err := LoadSkillForRun(db, scope, "qa-real-domain-run", skill.ID)
	if err != nil || pinned.KnowledgeSnapshot == nil || pinned.Hash != skill.Hash {
		t.Fatalf("actual native snapshot %v %#v", err, pinned.KnowledgeSnapshot)
	}
	engine := EngineClient{Cfg: cfg}
	status, raw, err := engine.Do(ctx, scope, Actor{Type: "user", ID: "u_alice"}, "GET", "/v1/video/skill-candidates/"+pack.Release.CandidateID, "", nil)
	var candidate struct {
		Data struct {
			State    string           `json:"state"`
			Receipts []map[string]any `json:"receipts"`
		} `json:"data"`
	}
	_ = json.Unmarshal(raw, &candidate)
	if err != nil || status != 200 || candidate.Data.State != "workspace_installed" || len(candidate.Data.Receipts) != 2 {
		t.Fatalf("actual durable receipts status%d %v %s", status, err, raw)
	}
	executable, _ := videoExecutableSHA256()
	if candidate.Data.Receipts[0]["executable_sha256"] != executable {
		t.Fatal("not this executing binary attestation")
	}
	knowledgeRaw, err := os.ReadFile(filepath.Join(os.Getenv("VIDEO_QA_RELEASE_DIR"), "knowledge.json"))
	if err != nil {
		t.Fatal(err)
	}
	var knowledge map[string]any
	_ = json.Unmarshal(knowledgeRaw, &knowledge)
	withdraw, _ := json.Marshal(map[string]any{"expected_version": knowledge["version"], "expected_hash": knowledge["content_hash"], "reason": "QA synthetic dependency withdrawal"})
	status, raw, err = engine.Do(ctx, scope, Actor{Type: "user", ID: "u_alice"}, "POST", "/v1/knowledge/"+knowledge["id"].(string)+"/withdraw", "withdraw-fixture", withdraw)
	if err != nil || status != 200 {
		t.Fatalf("real withdrawal status%d %v %s", status, err, raw)
	}
	if _, err := LoadSkillForRun(db, scope, "qa-real-domain-run", skill.ID); err == nil {
		t.Fatal("old pinned run bypassed actual withdrawn knowledge")
	}
	t.Logf("real Loom export→CLI→compiled registry→deployment check→actual binary receipt→workspace install→native snapshot→withdraw denial PASS; executable_sha256=%s; synthetic evidence/evaluator/reviewer only", executable)
}
