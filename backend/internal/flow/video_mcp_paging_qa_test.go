package flow

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

// AC18/AC05: actual go-sdk transport -> MCP handler -> signed EngineClient ->
// Loom HTTP -> background stages -> host evidence. Only acquisition is synthetic.
func TestVideoQAMCPPagingAndCrossEntryReplay(t *testing.T) {
	if os.Getenv("FLOW_VIDEO_CROSSLAYER_TEST") != "1" {
		t.Skip("set FLOW_VIDEO_CROSSLAYER_TEST=1 with Loom dependencies installed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	node := os.Getenv("VIDEO_QA_NODE")
	if node == "" {
		node = "node"
	}
	cmd := exec.CommandContext(ctx, node, "--experimental-strip-types", "validation/video-knowledge/gateway-paging-loom-harness.ts")
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
	profile := call("POST", "/v1/video/profiles", "paging-profile", map[string]any{"name": "Synthetic SDK paging", "config": map[string]any{"required_capabilities": []string{"transcript"}}})
	source := call("POST", "/v1/sources", "paging-source", map[string]any{"kind": "bilibili", "title": "Synthetic paging source", "url": "https://www.bilibili.com/video/BV1QA0000001?p=1", "config": map[string]any{"source_type": "video", "native_id": "BV1QA0000001", "part_id": "1", "profile_id": profile["id"], "profile_version": profile["version"], "usage_basis": "Self-authored synthetic fixture; no platform acquisition", "allowed_uses": []string{"knowledge"}}})
	mcpServer := httptest.NewServer(VideoMCPHandler(db, cfg, engine))
	t.Cleanup(mcpServer.Close)
	gateway := MCPGateway{DB: db, InternalConfig: &cfg, TrustedServices: []TrustedMCPService{{Endpoint: mcpServer.URL + "/mcp", ServiceIdentity: VideoMCPService, Audience: VideoMCPAudience, Addresses: []string{"127.0.0.1"}, AllowHTTP: true}}}
	conn, err := gateway.Create(scope, "u_alice", MCPConnectionInput{Name: "Synthetic SDK paging", Endpoint: mcpServer.URL + "/mcp", CostRule: MCPCostRule{ReconcileTool: "video_job_reconcile"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := gateway.Approve(ctx, scope, conn.ID, "u_alice", []string{"video_process_start", "video_job_status", "video_result_read", "video_job_reconcile"}); err != nil {
		t.Fatal(err)
	}
	invoke := func(tool string, args map[string]any, key string) map[string]any {
		t.Helper()
		result, truncated, err := gateway.ExecuteKeyed(ctx, scope, "u_alice", conn.ID, tool, args, key)
		if err != nil || truncated {
			t.Fatalf("SDK %s: error=%v truncated=%v result=%s", tool, err, truncated, result)
		}
		if len([]rune(result)) > 7800 {
			t.Fatalf("SDK response exceeds bounded output: %d", len([]rune(result)))
		}
		var data map[string]any
		if err := json.Unmarshal([]byte(result), &data); err != nil {
			t.Fatalf("SDK returned partial/non-JSON output: %v", err)
		}
		return data
	}
	args := map[string]any{"source_id": source["id"], "native_id": "BV1QA0000001", "part_id": "1"}
	started := time.Now()
	start := invoke("video_process_start", args, "paging-mcp-start")
	job, _ := start["video_job_id"].(string)
	if job == "" || start["operation_id"] == nil || start["completion_level"] == "knowledge_ready" {
		t.Fatalf("start must return a durable asynchronous handle, not block on processing: %#v", start)
	}
	t.Logf("short MCP start returned after %s; processing remains background", time.Since(started))
	if replay := call("POST", "/v1/video/jobs", "paging-manual-start", args); replay["video_job_id"] != job {
		t.Fatalf("manual/MCP entries duplicated semantic job: %#v", replay)
	}
	call("POST", "/v1/schedules", "paging-schedule", map[string]any{"source_ids": []string{source["id"].(string)}, "interval_seconds": 3600})
	for {
		status := invoke("video_job_status", map[string]any{"video_job_id": job}, "")
		if status["completion_level"] == "knowledge_ready" {
			break
		}
		if status["state"] == "failed" || status["state"] == "reconciliation_required" || ctx.Err() != nil {
			t.Fatalf("background processing did not become knowledge_ready: %#v", status)
		}
		time.Sleep(50 * time.Millisecond)
	}
	var all []map[string]any
	cursor, pages := "0", 0
	for {
		page := invoke("video_result_read", map[string]any{"video_job_id": job, "kind": "transcript", "cursor": cursor, "limit": 100}, "")
		if page["complete"] != true {
			t.Fatalf("completed job artifact page not complete: %#v", page)
		}
		items, ok := page["items"].([]any)
		if !ok || len(items) == 0 {
			t.Fatalf("artifact cursor failed to progress: %#v", page)
		}
		for _, item := range items {
			all = append(all, item.(map[string]any))
		}
		pages++
		if page["next_cursor"] == nil {
			break
		}
		next, ok := page["next_cursor"].(string)
		if !ok || next != strconv.Itoa(len(all)) || next == cursor || pages > 100 {
			t.Fatalf("non-monotonic cursor: prior=%s next=%v count=%d", cursor, page["next_cursor"], len(all))
		}
		cursor = next
	}
	if pages < 10 || len(all) != 81 {
		t.Fatalf("lossy/unbounded artifact paging: pages=%d items=%d", pages, len(all))
	}
	seen := map[string]bool{}
	var expectedText []string
	for i, evidence := range all {
		repeats := 50
		if i == 40 {
			repeats = 420
		}
		want := fmt.Sprintf("segment-%03d:", i) + strings.Repeat("\u4e2d\u6587\U0001f9ea", repeats) + fmt.Sprintf(":tail-%d", i)
		expectedText = append(expectedText, want)
		id, _ := evidence["evidence_id"].(string)
		if id == "" || seen[id] {
			t.Fatalf("missing/duplicate fixed evidence: %q", id)
		}
		seen[id] = true
		digest := sha256.Sum256([]byte(want))
		if evidence["snippet_hash"] != hex.EncodeToString(digest[:]) || evidence["start_ms"] != float64(i*1000) || evidence["end_ms"] != float64((i+1)*1000) {
			t.Fatalf("evidence identity/time changed at %d: %#v", i, evidence)
		}
		if i == 40 {
			if evidence["quote"] != nil || evidence["quote_complete"] != false || evidence["quote_excerpt"] == nil {
				t.Fatalf("long quote falsely represented as complete: %#v", evidence)
			}
			full := call("POST", "/v1/documents/read", "", evidence["read_ref"])
			if full["text"] != want {
				t.Fatal("long quote read_ref did not recover exact Unicode content")
			}
		} else if evidence["quote"] != want || evidence["quote_complete"] != true {
			t.Fatalf("artifact segment changed at %d", i)
		}
	}
	// Follow the immutable host revision in deliberately small pages as well;
	// offsets are UTF-16, not Go UTF-8 bytes/runes, and must include the full tail.
	var document strings.Builder
	offset := 0
	for {
		page := call("POST", "/v1/documents/read", "", map[string]any{"document_id": all[0]["document_id"], "revision": all[0]["revision"], "offset": offset, "max_chars": 997})
		part := page["text"].(string)
		document.WriteString(part)
		offset += len(utf16.Encode([]rune(part)))
		coverage := page["coverage"].(map[string]any)
		if coverage["next_offset"] == nil {
			if coverage["total_chars"] != float64(offset) {
				t.Fatal("document total differs from reconstructed UTF16 length")
			}
			break
		}
		if coverage["next_offset"] != float64(offset) {
			t.Fatal("document cursor skipped or duplicated Unicode text")
		}
	}
	if want := "Synthetic paging source\n\n" + strings.Join(expectedText, "\n"); document.String() != want {
		t.Fatal("host document paging silently lost, reordered or repeated text")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"/__fixture/receipts", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var audit struct {
		Submissions []struct {
			Stage     string `json:"stage"`
			JobID     string `json:"job_id"`
			IntentKey string `json:"intent_key"`
		} `json:"submissions"`
		DiscoveryCalls       int `json:"discovery_calls"`
		Jobs                 int `json:"jobs"`
		KnowledgeReadyEvents int `json:"knowledge_ready_events"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&audit); err != nil {
		t.Fatal(err)
	}
	if audit.DiscoveryCalls != 1 || audit.Jobs != 1 || audit.KnowledgeReadyEvents != 1 || len(audit.Submissions) != 2 || audit.Submissions[0].Stage != "input" || audit.Submissions[1].Stage != "process" {
		t.Fatalf("manual/schedule/MCP replay duplicated acquisition/indexing: %#v", audit)
	}
	if audit.Submissions[0].JobID != job || audit.Submissions[1].JobID != job || audit.Submissions[0].IntentKey == "" || audit.Submissions[1].IntentKey == "" || audit.Submissions[0].IntentKey == audit.Submissions[1].IntentKey {
		t.Fatalf("external submission receipts do not bind the unique job/stages: %#v", audit.Submissions)
	}
	t.Logf("mode=synthetic-provider real Go SDK -> Loom background -> %d pages/%d evidence/UTF16 %d chars; one input, one process, one readiness event", pages, len(all), offset)
}
