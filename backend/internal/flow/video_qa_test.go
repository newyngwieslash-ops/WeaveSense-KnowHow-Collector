package flow

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"yingce/backend/internal/model"
)

// Opt-in because the cross-language test needs the locked Loom node_modules.
// This uses the real Go gateway, go-sdk HTTP transport, thin MCP handler,
// EngineClient, Loom HTTP router and migrated PGlite, not fakeEngine.
func TestVideoQACrossLanguageGateway(t *testing.T) {
	if os.Getenv("FLOW_VIDEO_CROSSLAYER_TEST") != "1" {
		t.Skip("set FLOW_VIDEO_CROSSLAYER_TEST=1 with Loom dependencies installed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	node := os.Getenv("VIDEO_QA_NODE")
	if node == "" {
		node = "node"
	}
	cmd := exec.CommandContext(ctx, node, "--experimental-strip-types", "validation/video-knowledge/gateway-loom-harness.ts")
	cmd.Dir = filepath.Join("..", "..", "..", "services", "loom-engine")
	cmd.Env = append(os.Environ(), "VIDEO_QA_SIGNING_KEY="+string(key), "FLOW_VIDEO_ENABLED=true")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Signal(os.Interrupt); _ = cmd.Wait() })
	lines := make(chan string, 1)
	go func() {
		s := bufio.NewScanner(stdout)
		if s.Scan() {
			lines <- s.Text()
		} else {
			lines <- ""
		}
	}()
	var endpoint string
	select {
	case endpoint = <-lines:
	case <-ctx.Done():
		t.Fatal("Loom startup deadline exceeded")
	}
	if !strings.HasPrefix(endpoint, "http://127.0.0.1:") {
		t.Fatalf("Loom did not report endpoint: %q", endpoint)
	}
	db := testDB(t)
	scope, err := ResolveScope(db, "u_alice", "")
	if err != nil {
		t.Fatal(err)
	}
	cfg := Config{EngineURL: endpoint, SigningKey: key, Issuer: "flow-platform", Audience: "loom-engine", TTL: MaxTokenTTL}
	engine := EngineClient{Cfg: cfg}
	wrongIssuer := cfg
	wrongIssuer.Issuer = "untrusted-signed-issuer"
	if status, _, err := (EngineClient{Cfg: wrongIssuer}).Do(ctx, scope, Actor{Type: "user", ID: "u_alice"}, "GET", "/v1/video/profiles", "", nil); err != nil || status != 401 {
		t.Fatalf("valid signature with wrong issuer: status=%d err=%v", status, err)
	}
	call := func(method, path, idem string, body any) map[string]any {
		t.Helper()
		raw, _ := json.Marshal(body)
		status, out, err := engine.Do(ctx, scope, Actor{Type: "user", ID: "u_alice"}, method, path, idem, raw)
		if err != nil || status >= 400 {
			t.Fatalf("%s %s: status=%d error=%v body=%s", method, path, status, err, out)
		}
		var envelope struct {
			Data map[string]any `json:"data"`
		}
		if err := json.Unmarshal(out, &envelope); err != nil {
			t.Fatal(err)
		}
		return envelope.Data
	}
	profile := call("POST", "/v1/video/profiles", "qa-profile", map[string]any{"name": "QA synthetic research profile", "config": map[string]any{"required_capabilities": []string{"transcript"}}})
	source := call("POST", "/v1/sources", "qa-source", map[string]any{"kind": "bilibili", "title": "QA source", "url": "https://www.bilibili.com/video/BV1QA0000001?p=1", "config": map[string]any{"source_type": "video", "native_id": "BV1QA0000001", "part_id": "1", "profile_id": profile["id"], "profile_version": profile["version"], "usage_basis": "Synthetic integration fixture; no platform acquisition", "allowed_uses": []string{"knowledge"}}})
	mcpServer := httptest.NewServer(VideoMCPHandler(db, cfg, engine))
	t.Cleanup(mcpServer.Close)
	gateway := MCPGateway{DB: db, InternalConfig: &cfg, TrustedServices: []TrustedMCPService{{Endpoint: mcpServer.URL + "/mcp", ServiceIdentity: VideoMCPService, Audience: VideoMCPAudience, Addresses: []string{"127.0.0.1"}, AllowHTTP: true}}}
	conn, err := gateway.Create(scope, "u_alice", MCPConnectionInput{Name: "QA video", Endpoint: mcpServer.URL + "/mcp", CostRule: MCPCostRule{ReconcileTool: "video_job_reconcile"}})
	if err != nil {
		t.Fatal(err)
	}
	allowed := []string{"video_discover", "video_process_start", "video_job_status", "video_result_read", "video_job_cancel", "video_job_reconcile"}
	if _, err := gateway.Approve(ctx, scope, conn.ID, "u_alice", allowed); err != nil {
		t.Fatal(err)
	}
	discovered, _, err := gateway.ExecuteKeyed(ctx, scope, "u_alice", conn.ID, "video_discover", map[string]any{"source_id": source["id"]}, "qa-discover")
	if err != nil {
		t.Fatal(err)
	}
	var discovery map[string]any
	if err := json.Unmarshal([]byte(discovered), &discovery); err != nil {
		t.Fatal(err)
	}
	handle, _ := discovery["discovery_handle"].(string)
	if handle == "" || discovery["downloads_started"] != false {
		t.Fatalf("discovery did not return a non-downloading durable handle: %s", discovered)
	}
	for _, tool := range []string{"video_job_status", "video_result_read"} {
		page, truncated, err := gateway.Execute(ctx, scope, "u_alice", conn.ID, tool, map[string]any{"discovery_handle": handle})
		if err != nil || truncated || !strings.Contains(page, handle) || !strings.Contains(page, `"downloads_started":false`) {
			t.Fatalf("discovery read via %s: %v truncated=%v %s", tool, err, truncated, page)
		}
		if _, _, err := gateway.Execute(ctx, scope, "u_alice", conn.ID, tool, map[string]any{"discovery_handle": handle, "video_job_id": "ambiguous"}); err == nil {
			t.Fatalf("%s accepted ambiguous job/discovery selection", tool)
		}
	}
	args := map[string]any{"source_id": source["id"], "native_id": "BV1QA0000001", "part_id": "1"}
	start, truncated, err := gateway.ExecuteKeyed(ctx, scope, "u_alice", conn.ID, "video_process_start", args, "qa-start")
	if err != nil || truncated {
		t.Fatalf("real start: %v truncated=%v %s", err, truncated, start)
	}
	var receipt map[string]any
	if err := json.Unmarshal([]byte(start), &receipt); err != nil {
		t.Fatalf("structured receipt must remain JSON: %v %s", err, start)
	}
	job, _ := receipt["video_job_id"].(string)
	if job == "" || receipt["operation_id"] == nil {
		t.Fatalf("missing durable identifiers: %s", start)
	}
	replay, _, err := gateway.ExecuteKeyed(ctx, scope, "u_alice", conn.ID, "video_process_start", args, "qa-start")
	if err != nil || replay != start {
		t.Fatalf("replay differs: %v %s", err, replay)
	}
	// A new transport token has a new jti/iat, not a new business fingerprint.
	equivalent, _, err := gateway.ExecuteKeyed(ctx, scope, "u_alice", conn.ID, "video_process_start", args, "qa-equivalent-new-key")
	if err != nil || !strings.Contains(equivalent, job) {
		t.Fatalf("equivalent content with fresh delegation duplicated its job: %v %s; first=%s", err, equivalent, start)
	}
	if _, _, err := gateway.ExecuteKeyed(ctx, scope, "u_alice", conn.ID, "video_process_start", map[string]any{"source_id": source["id"], "native_id": "BV1QA0000002"}, "qa-start"); !errors.Is(err, ErrMCPKeyConflict) {
		t.Fatalf("same-key mismatch: %v", err)
	}
	recovered, _, err := gateway.Execute(ctx, scope, "u_alice", conn.ID, "video_job_reconcile", map[string]any{"idempotency_key": "qa-start"})
	if err != nil || !strings.Contains(recovered, job) {
		t.Fatalf("no-job-id recovery: %v %s", err, recovered)
	}
	missing, _, err := gateway.Execute(ctx, scope, "u_alice", conn.ID, "video_job_reconcile", map[string]any{"idempotency_key": "qa-never-submitted"})
	if err != nil || !strings.Contains(missing, `"status":"not_found"`) {
		t.Fatalf("scoped proof of absent submission: %v %s", err, missing)
	}
	if _, _, err := gateway.Execute(ctx, scope, "u_alice", conn.ID, "video_job_status", map[string]any{"video_job_id": job, "tenant_id": "forged"}); err == nil {
		t.Fatal("model-supplied tenant must be rejected")
	}
	bob, err := ResolveScope(db, "u_bob", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := gateway.Execute(ctx, bob, "u_bob", conn.ID, "video_job_status", map[string]any{"video_job_id": job}); !errors.Is(err, ErrMCPNotFound) {
		t.Fatalf("cross-workspace connection: %v", err)
	}
	status, out, err := engine.Do(ctx, bob, Actor{Type: "user", ID: "u_bob"}, "GET", "/v1/video/jobs/"+job, "", nil)
	if err != nil || status != 404 {
		t.Fatalf("cross-workspace Loom job: %d %v %s", status, err, out)
	}
	// Simulate lost delivery of a successful start receipt in the gateway ledger.
	if err := db.Model(&model.FlowMCPCall{}).Where("tenant_id = ? AND idem_key = ?", scope.TenantID, "qa-start").Updates(map[string]any{"status": StatusReconciliation, "output": ""}).Error; err != nil {
		t.Fatal(err)
	}
	resolved, _, err := gateway.ExecuteKeyed(ctx, scope, "u_alice", conn.ID, "video_process_start", args, "qa-start")
	if err != nil || !strings.Contains(resolved, job) {
		t.Fatalf("gateway automatic reconcile: %v %s", err, resolved)
	}
	if os.Getenv("FLOW_VIDEO_CONTROL_BENCHMARK") == "1" {
		var sources []string
		for i := 0; i < 10; i++ {
			nativeID := fmt.Sprintf("BV1QA%07d", i+100)
			benchSource := call("POST", "/v1/sources", fmt.Sprintf("qa-bench-source-%d", i), map[string]any{"kind": "bilibili", "title": "Synthetic capacity source", "url": "https://www.bilibili.com/video/" + nativeID, "config": map[string]any{"source_type": "video", "native_id": nativeID, "profile_id": profile["id"], "profile_version": profile["version"], "usage_basis": "Synthetic control-plane capacity fixture, no acquisition", "allowed_uses": []string{"knowledge"}}})
			sources = append(sources, benchSource["id"].(string))
		}
		videoControlBenchmark(t, ctx, gateway, scope, conn.ID, sources, cmd.Process.Pid)
	}
	if err := db.Model(&model.Membership{}).Where("user_id = ?", "u_alice").Update("status", "revoked").Error; err != nil {
		t.Fatal(err)
	}
	if _, _, err := gateway.Execute(ctx, scope, "u_alice", conn.ID, "video_job_status", map[string]any{"video_job_id": job}); err == nil {
		t.Fatal("execution must recheck revoked current membership")
	}
	t.Logf("mode=fixture-control-path operation_id=%s video_job_id=%s; platform, model, real-login and pilot not executed", receipt["operation_id"], job)
}

func TestVideoReconcileRequiresProofOfAbsentOriginalSubmission(t *testing.T) {
	args := map[string]any{"idempotency_key": "original-key"}
	if !videoReconcileProvenMissing(404, "video_job_reconcile", "VIDEO_SUBMISSION_NOT_FOUND", args) {
		t.Fatal("authoritative missing key not recognized")
	}
	for _, reason := range []string{"VIDEO_JOB_NOT_FOUND", "OBJECT_NOT_FOUND", "SOURCE_NOT_FOUND", ""} {
		if videoReconcileProvenMissing(404, "video_job_reconcile", reason, args) {
			t.Fatalf("downstream 404 falsely proved safe retry: %s", reason)
		}
	}
	args["video_job_id"] = "known-job"
	if videoReconcileProvenMissing(404, "video_job_reconcile", "VIDEO_SUBMISSION_NOT_FOUND", args) {
		t.Fatal("job-id lookup cannot prove original key absent")
	}
}

// Bounded control-plane workload only. No download, transcription, model or
// production throughput is inferred from these local synthetic requests.
func videoControlBenchmark(t *testing.T, ctx context.Context, gateway MCPGateway, scope Scope, connection string, sources []string, loomPID int) {
	t.Helper()
	const concurrent = 10
	jobs := make([]string, concurrent)
	type phase struct {
		SamplesMS []float64 `json:"samples_ms"`
		P95MS     float64   `json:"p95_ms"`
		Errors    []string  `json:"errors"`
	}
	results := map[string]phase{}
	for _, name := range []string{"start", "status", "cancel"} {
		result := phase{SamplesMS: make([]float64, concurrent), Errors: []string{}}
		var wait sync.WaitGroup
		var mu sync.Mutex
		start := make(chan struct{})
		for i := 0; i < concurrent; i++ {
			wait.Add(1)
			go func(i int) {
				defer wait.Done()
				<-start
				begin := time.Now()
				var output string
				var err error
				switch name {
				case "start":
					output, _, err = gateway.ExecuteKeyed(ctx, scope, "u_alice", connection, "video_process_start", map[string]any{"source_id": sources[i], "native_id": fmt.Sprintf("BV1QA%07d", i+100)}, fmt.Sprintf("qa-bench-start-%d", i))
					if err == nil {
						var receipt struct {
							JobID string `json:"video_job_id"`
						}
						if json.Unmarshal([]byte(output), &receipt) != nil || receipt.JobID == "" {
							err = errors.New("missing durable job receipt")
						}
						jobs[i] = receipt.JobID
					}
				case "status":
					output, _, err = gateway.Execute(ctx, scope, "u_alice", connection, "video_job_status", map[string]any{"video_job_id": jobs[i]})
				case "cancel":
					output, _, err = gateway.ExecuteKeyed(ctx, scope, "u_alice", connection, "video_job_cancel", map[string]any{"video_job_id": jobs[i], "reason": "synthetic capacity fixture"}, fmt.Sprintf("qa-bench-cancel-%d", i))
				}
				result.SamplesMS[i] = float64(time.Since(begin).Microseconds()) / 1000
				if err != nil {
					mu.Lock()
					result.Errors = append(result.Errors, fmt.Sprintf("request=%d error=%v", i, err))
					mu.Unlock()
				}
			}(i)
		}
		close(start)
		wait.Wait()
		sorted := append([]float64(nil), result.SamplesMS...)
		sort.Float64s(sorted)
		result.P95MS = sorted[concurrent-1] // nearest-rank p95 of 10 observations
		results[name] = result
	}
	rss := func(pid int) int64 {
		raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
		if err != nil {
			return -1
		}
		for _, line := range strings.Split(string(raw), "\n") {
			if strings.HasPrefix(line, "VmRSS:") {
				fields := strings.Fields(line)
				if len(fields) >= 2 {
					value, _ := strconv.ParseInt(fields[1], 10, 64)
					return value * 1024
				}
			}
		}
		return -1
	}
	cpuModel := "unavailable"
	if raw, err := os.ReadFile("/proc/cpuinfo"); err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			if strings.HasPrefix(line, "model name") {
				_, cpuModel, _ = strings.Cut(line, ":")
				cpuModel = strings.TrimSpace(cpuModel)
				break
			}
		}
	}
	report := map[string]any{"schema_version": 1, "mode": "synthetic-control-only", "stack": "real Go MCPGateway -> go-sdk HTTP -> VideoMCPHandler -> EngineClient -> Loom HTTP -> migrated PGlite", "concurrency": concurrent, "requests": 30, "warm_schema_connection": true, "host_db": "SQLite single connection test fixture", "loom_db": "PGlite", "measured_at": time.Now().UTC().Format(time.RFC3339), "os": runtime.GOOS, "arch": runtime.GOARCH, "cpu_model": cpuModel, "logical_cpus": runtime.NumCPU(), "gomaxprocs": runtime.GOMAXPROCS(0), "go_version": runtime.Version(), "go_rss_bytes_after": rss(os.Getpid()), "loom_rss_bytes_after": rss(loomPID), "phases": results, "limits": "RSS is one end-of-workload snapshot, not peak. No platform, media, paid model, production or long-duration throughput measured."}
	raw, _ := json.MarshalIndent(report, "", "  ")
	t.Logf("CONTROL_BENCHMARK_JSON=%s", raw)
	if path := os.Getenv("VIDEO_QA_CONTROL_REPORT"); path != "" {
		if err := os.WriteFile(path, append(raw, '\n'), 0644); err != nil {
			t.Fatal(err)
		}
	}
	for name, result := range results {
		if len(result.Errors) != 0 || result.P95MS >= 3000 {
			t.Errorf("%s control SLO not met: p95=%.3fms errors=%v", name, result.P95MS, result.Errors)
		}
	}
}

func TestVideoQATrustedTransportDoesNotEnableOtherLoopback(t *testing.T) {
	db := testDB(t)
	scope, err := ResolveScope(db, "u_alice", "")
	if err != nil {
		t.Fatal(err)
	}
	gateway := MCPGateway{DB: db, TrustedServices: []TrustedMCPService{{Endpoint: "http://127.0.0.1:9988/mcp", ServiceIdentity: VideoMCPService, Audience: VideoMCPAudience, Addresses: []string{"127.0.0.1"}, AllowHTTP: true}}}
	for _, endpoint := range []string{"http://127.0.0.1:9989/mcp", "http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:9988/other"} {
		if _, err := gateway.Create(scope, "u_alice", MCPConnectionInput{Name: "not trusted", Endpoint: endpoint}); err == nil {
			t.Fatalf("unlisted internal endpoint accepted: %s", endpoint)
		}
	}
}
