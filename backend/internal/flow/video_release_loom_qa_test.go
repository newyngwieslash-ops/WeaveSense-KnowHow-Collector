package flow

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"yingce/backend/internal/model"
)

// An independently exported real Loom candidate crosses the actual CLI/embed
// compiler and running host. Only the external model, reviewer and evidence are
// fixtures; evaluation tasks, comparison scoring and host billing are real.
func TestVideoQALoomExportBuildAndRunningRegistry(t *testing.T) {
	if os.Getenv("FLOW_VIDEO_RELEASE_BUILD_TEST") != "1" {
		t.Skip("opt-in actual isolated compiler/domain integration")
	}
	db := testDB(t)
	scope, err := ResolveScope(db, "u_alice", "")
	if err != nil {
		t.Fatal(err)
	}
	fund(t, Billing{DB: db}, "u_alice", 20_000_000)
	var modelCalls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Model    string                           `json:"model"`
			Messages []struct{ Role, Content string } `json:"messages"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.Model != "fixture-release-model" || len(body.Messages) != 2 || r.Header.Get("Idempotency-Key") == "" || r.Header.Get("X-Flow-Reservation-Id") == "" {
			t.Error("evaluation bypassed real managed gateway")
			w.WriteHeader(400)
			return
		}
		var input struct {
			CaseID  string          `json:"case_id"`
			Variant string          `json:"variant"`
			Method  json.RawMessage `json:"method"`
		}
		if json.Unmarshal([]byte(body.Messages[1].Content), &input) != nil || input.CaseID == "" || !strings.Contains(body.Messages[0].Content, "deterministic evaluation gates") {
			t.Error("evaluation prompt contract absent")
			w.WriteHeader(400)
			return
		}
		if (input.Variant == "without_skill") != (string(input.Method) == "null") {
			t.Error("three-way comparison did not change method input")
		}
		modelCalls.Add(1)
		result, _ := json.Marshal(map[string]any{"case_id": input.CaseID, "output": "fixture", "unsupported_claims": []string{}, "permission_violations": []string{}, "missing_evidence": []string{}, "limitations": []string{"synthetic external model, not industry quality"}})
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": string(result)}}}, "usage": map[string]any{"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30}})
	}))
	defer provider.Close()
	gw := &OpenAICompatGateway{URL: provider.URL, Model: "fixture-release-model", MicroPer1KTok: 1000, HTTP: provider.Client()}
	cfg := Config{SigningKey: key, Issuer: "flow-platform", Audience: "loom-engine", TTL: MaxTokenTTL}
	var router atomic.Pointer[gin.Engine]
	bootstrap := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if current := router.Load(); current != nil {
			current.ServeHTTP(w, r)
		} else {
			w.WriteHeader(503)
		}
	}))
	defer bootstrap.Close()
	root := t.TempDir()
	data := filepath.Join(root, "loom-data")
	if err := os.Mkdir(data, 0700); err != nil {
		t.Fatal(err)
	}
	loom, _ := filepath.Abs("../../../services/loom-engine")
	scopeJSON, _ := json.Marshal(map[string]string{"tenant_id": scope.TenantID, "workspace_id": scope.WorkspaceID})
	env := append(os.Environ(), "VIDEO_QA_RELEASE_DIR="+data, "VIDEO_QA_SIGNING_KEY="+string(key), "VIDEO_QA_SCOPE="+string(scopeJSON), "VIDEO_QA_HOST_URL="+bootstrap.URL, "FLOW_VIDEO_ENABLED=true")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	export := exec.CommandContext(ctx, "node", "--experimental-strip-types", "validation/video-knowledge/release-loom-qa.ts", "export")
	export.Dir, export.Env = loom, env
	stdout, err := export.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdin, err := export.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	export.Stderr = &stderr
	if err := export.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = export.Process.Kill() })
	lines := bufio.NewScanner(stdout)
	if !lines.Scan() || !strings.HasPrefix(lines.Text(), "http://127.0.0.1:") {
		t.Fatalf("Loom evaluation startup failed: %s %s", lines.Text(), stderr.String())
	}
	cfg.EngineURL = lines.Text()
	t.Setenv("LOOM_ENGINE_URL", cfg.EngineURL)
	t.Setenv("FLOW_INTERNAL_JWT_SIGNING_KEY", string(key))
	t.Setenv("FLOW_INTERNAL_JWT_ISSUER", "flow-platform")
	t.Setenv("FLOW_INTERNAL_JWT_AUDIENCE", "loom-engine")
	r := gin.New()
	registerVideoModelRoutes(r.Group("/api"), db, cfg, gw)
	router.Store(r)
	workerCtx, stopWorker := context.WithCancel(ctx)
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		tick := time.NewTicker(20 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-workerCtx.Done():
				return
			case <-tick.C:
				_, _ = (ModelTasks{DB: db, GW: gw}).RunDue(workerCtx)
			}
		}
	}()
	defer func() { stopWorker(); <-workerDone }()
	_, _ = stdin.Write([]byte("go\n"))
	_ = stdin.Close()
	if !lines.Scan() || lines.Text() != "EXPORTED_REAL_DOMAIN_FIXTURE" {
		t.Fatalf("actual evaluator/export failed: %s %s", lines.Text(), stderr.String())
	}
	if err := export.Wait(); err != nil {
		t.Fatalf("actual Loom export: %v\n%s", err, stderr.String())
	}
	stopWorker()
	<-workerDone
	var tasks []model.FlowModelTask
	if err := db.Where("purpose = ?", "video_skill_evaluate").Find(&tasks).Error; err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 120 || modelCalls.Load() != 120 {
		t.Fatalf("expected 20 cases x 3 variants x 2 versions: tasks=%d model_calls=%d", len(tasks), modelCalls.Load())
	}
	for _, task := range tasks {
		if task.Status != "succeeded" || task.CostMicro != 30 || task.ReservationID == "" {
			t.Fatalf("evaluation did not execute through billed task: %+v", task)
		}
	}
	var parents []model.FlowBudgetReservation
	db.Where("purpose = ?", "video_model_parent").Find(&parents)
	if len(parents) != 2 || parents[0].AllocatedMicro != 0 || parents[1].AllocatedMicro != 0 || parents[0].ConsumedMicro != 1800 || parents[1].ConsumedMicro != 1800 {
		t.Fatalf("bounded evaluation budgets not reconciled: %+v", parents)
	}
	t.Logf("actual evaluator: 2 versions x 20 synthetic cases x 3 variants = 120 managed model tasks; actual synthetic usage cost_micro=3600; both parent allocations closed")
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
	for _, version := range []string{"1.0.0", "2.0.0"} {
		run("run", "-p", "2", "./cmd/video-skill-release", "--input", filepath.Join(data, "candidate-"+version+".json"), "--archive-root", archive)
		run("run", "-p", "2", "./cmd/video-skill-release", "--input", filepath.Join(data, "candidate-"+version+".json"), "--check")
		binary := filepath.Join(root, "actual-loom-release-"+version+".test")
		run("test", "-p", "2", "-c", "-o", binary, "./internal/flow")
		child := exec.Command(binary, "-test.run", "^TestVideoQALoomReleaseCompiledChild$", "-test.v")
		child.Dir = filepath.Join(build, "internal/flow")
		child.Env = append(env, "FLOW_VIDEO_QA_LOOM_RELEASE_CHILD=1", "VIDEO_QA_LOOM_DIRECTORY="+loom, "VIDEO_QA_RELEASE_PHASE="+version)
		if out, err := child.CombinedOutput(); err != nil {
			t.Fatalf("compiled real domain runtime %s: %v\n%s", version, err, out)
		} else {
			t.Log(string(out))
		}
	}
}

func TestVideoQALoomReleaseCompiledChild(t *testing.T) {
	if os.Getenv("FLOW_VIDEO_QA_LOOM_RELEASE_CHILD") != "1" {
		t.Skip("only runs in isolated actual-domain archive")
	}
	phase := os.Getenv("VIDEO_QA_RELEASE_PHASE")
	hostFile := filepath.Join(os.Getenv("VIDEO_QA_RELEASE_DIR"), "old-host.db")
	var db *gorm.DB
	if phase == "1.0.0" {
		db = testDB(t)
	} else {
		if _, err := os.Stat(hostFile); err != nil {
			t.Fatal("old host database missing", err)
		}
		var err error
		db, err = gorm.Open(sqlite.Open(hostFile), &gorm.Config{Logger: logger.Discard})
		if err != nil {
			t.Fatal(err)
		}
		sqlDB, _ := db.DB()
		sqlDB.SetMaxOpenConns(1)
		t.Cleanup(func() { _ = sqlDB.Close() })
	}
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
	v2, ok := FindSkill(skill.ID, "2.0.0")
	pack2, ok2 := skillPackFor(v2)
	if phase == "1.0.0" && ok {
		t.Fatal("old build unexpectedly includes the new version")
	}
	if phase == "2.0.0" && (!ok || !ok2 || pack2.Release == nil || skill.Hash == v2.Hash) {
		t.Fatal("second actual-domain historical archive absent")
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
	if phase == "1.0.0" {
		invoke(installPath, install, "", "before-attestation", 409)
	}
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
	if phase == "1.0.0" {
		invoke("/api/internal/flow/video/skills/"+skill.ID+"/attest", map[string]any{"version": skill.Version, "hash": skill.Hash}, token, "", 200)
	}
	invoke(installPath, install, "", "actual-domain-install", 200)
	invoke(installPath, install, "", "actual-domain-install", 200)
	pinned, err := LoadSkillForRun(db, scope, "qa-real-domain-run", skill.ID)
	if err != nil || pinned.KnowledgeSnapshot == nil || pinned.Hash != skill.Hash {
		t.Fatalf("actual native snapshot %v %#v", err, pinned.KnowledgeSnapshot)
	}
	executable, _ := videoExecutableSHA256()
	oldSnapshotFile := filepath.Join(os.Getenv("VIDEO_QA_RELEASE_DIR"), "old-host-pin.json")
	if phase == "1.0.0" {
		if err := db.Exec("VACUUM INTO ?", hostFile).Error; err != nil {
			t.Fatal("persist old host database", err)
		}
		snapshot, _ := json.Marshal(map[string]any{"executable_sha256": executable, "native_hash": skill.Hash, "snapshot_id": pinned.KnowledgeSnapshot.ID})
		if err := os.WriteFile(oldSnapshotFile, snapshot, 0600); err != nil {
			t.Fatal(err)
		}
		t.Logf("old build deployed, installed and pinned; durable host snapshot=%s", snapshot)
		return
	}
	oldRaw, err := os.ReadFile(oldSnapshotFile)
	var oldSnapshot map[string]string
	if err != nil || json.Unmarshal(oldRaw, &oldSnapshot) != nil || oldSnapshot["executable_sha256"] == executable || oldSnapshot["native_hash"] != pinned.Hash || oldSnapshot["snapshot_id"] != pinned.KnowledgeSnapshot.ID {
		t.Fatalf("new executable did not preserve the old host run and knowledge snapshot: %v %s", err, oldRaw)
	}
	assertPin := func(run string, expected Skill, snapshot string) {
		t.Helper()
		actual, err := LoadSkillForRun(db, scope, run, skill.ID)
		if err != nil || actual.Hash != expected.Hash || actual.Version != expected.Version || actual.KnowledgeSnapshot == nil || (snapshot != "" && actual.KnowledgeSnapshot.ID != snapshot) {
			t.Fatalf("frozen native run %s changed: %v %+v", run, err, actual)
		}
	}
	installV2 := map[string]any{"skill_id": v2.ID, "version": v2.Version, "hash": v2.Hash, "expected_hash": pack2.Release.CandidateHash, "expected_install_hash": skill.Hash}
	installPathV2 := "/api/intelligence/video/skill-candidates/" + pack2.Release.CandidateID + "/install"
	invoke(installPathV2, installV2, "", "v2-before-deployment", 409)
	invoke("/api/internal/flow/video/skills/"+v2.ID+"/attest", map[string]any{"version": v2.Version, "hash": strings.Repeat("0", 64)}, token, "", 409)
	assertPin("qa-run-after-failed-deploy", skill, "")
	invoke("/api/internal/flow/video/skills/"+v2.ID+"/attest", map[string]any{"version": v2.Version, "hash": v2.Hash}, token, "", 200)
	// Building and deployment must never silently change the workspace pin.
	assertPin("qa-run-after-successful-deploy", skill, "")
	installV2["expected_install_hash"] = ""
	invoke(installPathV2, installV2, "", "v2-missing-cas", 409)
	installV2["expected_install_hash"] = skill.Hash
	invoke(installPathV2, installV2, "", "actual-domain-upgrade", 200)
	invoke(installPathV2, installV2, "", "actual-domain-upgrade", 200)
	assertPin("qa-real-domain-new-run", v2, "")
	assertPin("qa-real-domain-run", skill, pinned.KnowledgeSnapshot.ID)
	install["expected_install_hash"] = skill.Hash
	invoke(installPath, install, "", "stale-domain-rollback", 409)
	assertPin("qa-run-after-stale-rollback", v2, "")
	install["expected_install_hash"] = v2.Hash
	invoke(installPath, install, "", "actual-domain-rollback", 200)
	assertPin("qa-real-domain-rollback-run", skill, "")
	assertPin("qa-real-domain-new-run", v2, "")
	assertPin("qa-real-domain-run", skill, pinned.KnowledgeSnapshot.ID)
	if _, err := InstallSkill(db, scope, "u_alice", skill.ID, skill.Version); err == nil {
		t.Fatal("generic installer bypassed real domain governance")
	}
	engine := EngineClient{Cfg: cfg}
	for _, target := range []Skill{skill, v2} {
		release, _ := skillPackFor(target)
		status, raw, err := engine.Do(ctx, scope, Actor{Type: "user", ID: "u_alice"}, "GET", "/v1/video/skill-candidates/"+release.Release.CandidateID, "", nil)
		var candidate struct {
			Data struct {
				State    string           `json:"state"`
				Receipts []map[string]any `json:"receipts"`
			} `json:"data"`
		}
		_ = json.Unmarshal(raw, &candidate)
		wantReceipts := 2
		if target.Version == "1.0.0" {
			wantReceipts = 3
		}
		if err != nil || status != 200 || candidate.Data.State != "workspace_installed" || len(candidate.Data.Receipts) != wantReceipts {
			t.Fatalf("actual durable receipts version%s status%d %v %s", target.Version, status, err, raw)
		}
		expectedExecutable := executable
		if target.Version == "1.0.0" {
			expectedExecutable = oldSnapshot["executable_sha256"]
		}
		if candidate.Data.Receipts[0]["executable_sha256"] != expectedExecutable || candidate.Data.Receipts[0]["release_package_hash"] != release.Release.ReleasePackageHash {
			t.Fatal("not this executing binary/package attestation")
		}
		for _, receipt := range candidate.Data.Receipts {
			if receipt["version"] != target.Version || receipt["hash"] != target.Hash {
				t.Fatal("version or hash changed across lifecycle", receipt)
			}
		}
		t.Logf("actual TEST lifecycle version=%s native_hash=%s candidate_hash=%s receipts=%s", target.Version, target.Hash, release.Release.CandidateHash, mustJSON(candidate.Data.Receipts))
	}
	knowledgeRaw, err := os.ReadFile(filepath.Join(os.Getenv("VIDEO_QA_RELEASE_DIR"), "knowledge.json"))
	if err != nil {
		t.Fatal(err)
	}
	var knowledge map[string]any
	_ = json.Unmarshal(knowledgeRaw, &knowledge)
	withdraw, _ := json.Marshal(map[string]any{"expected_version": knowledge["version"], "expected_hash": knowledge["content_hash"], "reason": "QA synthetic dependency withdrawal"})
	status, raw, err := engine.Do(ctx, scope, Actor{Type: "user", ID: "u_alice"}, "POST", "/v1/knowledge/"+knowledge["id"].(string)+"/withdraw", "withdraw-fixture", withdraw)
	if err != nil || status != 200 {
		t.Fatalf("real withdrawal status%d %v %s", status, err, raw)
	}
	for _, run := range []string{"qa-real-domain-run", "qa-real-domain-new-run", "qa-real-domain-rollback-run"} {
		if _, err := LoadSkillForRun(db, scope, run, skill.ID); err == nil {
			t.Fatal("old pinned run bypassed actual withdrawn knowledge", run)
		}
	}
	installV2["expected_install_hash"] = skill.Hash
	invoke(installPathV2, installV2, "", "withdrawn-upgrade", 409)
	invoke(installPath, install, "", "withdrawn-rollback", 409)
	t.Log(fmt.Sprintf("real Loom evaluator→gateway→billing→approve→export→CLI→compiled registry→deployment check→binary receipt→install→upgrade→rollback→frozen native snapshots→current withdrawal denial PASS; executable_sha256=%s; synthetic external model/evidence/reviewer only", executable))
}
