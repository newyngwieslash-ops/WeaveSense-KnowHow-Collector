package flow

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"yingce/backend/internal/model"
)

func TestVideoCoreNativeIntelligenceAndCanvasExecution(t *testing.T) {
	tools, engine, conv, ss := setupP3(t)
	skill, found := FindSkill("video-knowledge-core", "1.0.0")
	if !found || len(skill.Hash) != 64 {
		t.Fatal("embedded native pack missing")
	}
	loom := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			RunID  string   `json:"run_id"`
			Method SkillRef `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&input)
		claim, err := Verify(key, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), "loom-engine", time.Now())
		if err != nil || r.URL.Path != "/v1/knowledge/snapshots" || claim.Actor.ID != "video-skill-reader" || claim.JobID != input.RunID || input.Method != skill.Ref() {
			w.WriteHeader(403)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": VideoKnowledgeSnapshot{ID: "fixture-snapshot-" + input.RunID, RunID: input.RunID, Method: input.Method, ContentHash: strings.Repeat("b", 64)}})
	}))
	defer loom.Close()
	t.Setenv("LOOM_ENGINE_URL", loom.URL)
	t.Setenv("FLOW_INTERNAL_JWT_SIGNING_KEY", string(key))
	if _, err := InstallSkill(tools.DB, ss.Scope, "u_alice", skill.ID, skill.Version); err != nil {
		t.Fatal(err)
	}
	loaded, err := tools.Invoke(context.Background(), conv, ss, "u_alice", "video-skill-load", "intel_load_skill", map[string]any{"skill_id": skill.ID}, "")
	if err != nil || loaded.Status != "succeeded" || !strings.Contains(string(loaded.Output), skill.Hash) {
		t.Fatalf("native intelligence load: %+v %v", loaded, err)
	}
	if !strings.Contains(string(loaded.Output), "knowledge_snapshot") {
		t.Fatal("native method omitted knowledge snapshot")
	}
	var pin model.FlowSkillRunPin
	if tools.DB.Where("run_id = ? AND skill_id = ?", tools.RunID, skill.ID).First(&pin).Error != nil || pin.Hash != skill.Hash {
		t.Fatal("run did not freeze native hash")
	}
	fund(t, Billing{DB: tools.DB}, "u_alice", 5_000_000)
	hash := strings.Repeat("a", 64)
	engine.evidence = []ResolvedEvidence{{EvidenceID: "video-evidence", DocumentID: "video-document", SourceID: "video-source", Revision: 1, SnippetHash: hash}}
	output := map[string]any{"profile_id": "profile-1", "profile_version": 1, "relevance": "uncertain", "knowledge_units": []any{}, "missing_information": []string{"Insufficient evidence for a supported knowledge unit."}, "coverage_limitations": []string{"Fixture only; no real platform verification."}}
	outputRaw, _ := json.Marshal(output)
	calls := &atomic.Int32{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if r.Header.Get("X-Flow-Reservation-Id") == "" || !strings.Contains(string(mustJSON(body)), skill.Hash) || !strings.Contains(string(mustJSON(body)), "knowledge_snapshot") {
			t.Error("not an actual managed native template invocation")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": string(outputRaw)}}}, "usage": map[string]any{"prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70}})
	}))
	defer srv.Close()
	tools.Model = &OpenAICompatGateway{URL: srv.URL, Model: "fixture-model", MicroPer1KTok: 1000, HTTP: srv.Client()}
	if err := tools.DB.AutoMigrate(&model.CanvasWorkflowExecution{}); err != nil {
		t.Fatal(err)
	}
	_, _ = (Billing{DB: tools.DB}).Account(tools.DB, ss.Scope.TenantID)
	if err := tools.DB.Create(&model.CanvasProject{ID: "video-canvas", UserID: "u_alice", Revision: 1, PayloadJSON: `{"nodes":[{"id":"video-skill-node","type":"skill"}],"connections":[]}`}).Error; err != nil {
		t.Fatal(err)
	}
	authority := &canvasSkillTestAuthority{skill: skill.Ref(), route: map[string]any{"flow_model_gateway": map[string]any{"model": "fixture-model", "url_hash": canvasSkillDigest([]byte(srv.URL)), "pricing_hash": hashJSON(int64(1000)), "micro_per_1k_tokens": int64(1000)}}}
	executions := &CanvasWorkflowExecutions{DB: tools.DB, Authority: authority}
	rev := int64(1)
	run, err := executions.Admit(context.Background(), CanvasWorkflowAdmission{UserID: "u_alice", TenantID: ss.Scope.TenantID, WorkspaceID: ss.Scope.WorkspaceID, CanvasID: "video-canvas", ExecutionKey: "video-core-execution", ExpectedRevision: &rev, BudgetMicro: 1_000_000})
	if err != nil {
		t.Fatal(err)
	}
	fence, err := executions.Acquire(context.Background(), "u_alice", run.ID, "video-test-worker")
	if err != nil {
		t.Fatal(err)
	}
	request := CanvasWorkflowSkillRequest{Executions: executions, WorkerID: "video-test-worker", FencingToken: fence, UserID: "u_alice", RunID: run.ID, NodeID: "video-skill-node", ModelID: "fixture-model", ApprovedSkill: skill.Ref(), BudgetMicro: 200_000, MaxTokens: 2048, MaterialScope: MaterialScope{DocumentIDs: []string{"video-document"}},
		Input: map[string]any{"profile_id": "profile-1", "profile_version": 1, "evidence": []any{map[string]any{"evidence_id": "video-evidence", "revision": 1, "snippet_hash": hash, "quote": "No supported numerical conclusion."}}}}
	result, err := tools.ExecuteCanvasWorkflowSkill(context.Background(), request)
	if err != nil || result.Status != "succeeded" || result.Skill.Hash != skill.Hash || calls.Load() != 1 {
		t.Fatalf("native Canvas execution: %+v %v calls=%d", result, err, calls.Load())
	}
	again, err := tools.ExecuteCanvasWorkflowSkill(context.Background(), request)
	if err != nil || again.TaskID != result.TaskID || calls.Load() != 1 {
		t.Fatalf("native replay repeated paid call: %+v %v", again, err)
	}
}

func mustJSON(v any) []byte { raw, _ := json.Marshal(v); return raw }
