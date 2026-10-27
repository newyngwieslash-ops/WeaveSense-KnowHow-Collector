package flow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"gorm.io/gorm"
)

type videoMCPTool struct {
	name, description, scope string
	schema                   map[string]any
}

func videoMCPTools() []videoMCPTool {
	return []videoMCPTool{
		{"video_discover", "Request bounded discovery only; no implicit download. A slow scan returns a durable operation handle; discovery_handle resumes an authorized partial scan with a new idempotency key.", "intel.video.process", obj([]string{"source_id"}, map[string]any{"source_id": tStr, "limit": tInt, "deadline_ms": tInt, "discovery_handle": tStr})},
		{"video_process_start", "Submit a discovered native video ID to the workspace's durable Loom coordinator. Discover URLs first. Returns operation_id and video_job_id; no synchronous media processing.", "intel.video.process", obj([]string{"source_id", "native_id"}, map[string]any{"source_id": tStr, "native_id": tStr, "part_id": tStr, "canonical_url": tStr, "profile_id": tStr, "profile_version": tInt, "content_version": tStr, "required_capabilities": tStrs, "processor_version": tStr})},
		{"video_job_status", "Read authoritative job stages or discovery status using exactly one video_job_id or discovery_handle; completed is not publication approval.", "intel.video.read", obj([]string{}, map[string]any{"video_job_id": tStr, "discovery_handle": tStr})},
		{"video_result_read", "Read a bounded result page or discovery results using exactly one video_job_id or discovery_handle; follow next_cursor and visual read_ref/text_offset, never treat truncated output as complete evidence.", "intel.video.read", obj([]string{}, map[string]any{"video_job_id": tStr, "discovery_handle": tStr, "cursor": tStr, "limit": tInt, "kind": tStr, "text_offset": tInt, "record_id": tStr, "conflict_offset": map[string]any{"type": "integer", "minimum": 0, "maximum": 8}, "text_field": map[string]any{"type": "string", "enum": []string{"text", "audio", "visual"}}})},
		{"video_job_cancel", "Persist host cancellation before remote best-effort stop. Host state and remote cancellation confirmation are separate.", "intel.video.process", obj([]string{"video_job_id"}, map[string]any{"video_job_id": tStr, "reason": tStr})},
		{"video_job_reconcile", "Recover a prior submission by host idempotency_key, even when video_job_id was lost. Never blindly submit again.", "intel.video.process", obj([]string{}, map[string]any{"video_job_id": tStr, "idempotency_key": tStr})},
	}
}

func videoMCPRoute(name string, a map[string]any) (string, string, any) {
	id := url.PathEscape(argStr(a, "video_job_id"))
	switch name {
	case "video_discover":
		return "POST", "/v1/video/discover", a
	case "video_process_start":
		return "POST", "/v1/video/jobs", a
	case "video_job_status":
		if handle := argStr(a, "discovery_handle"); handle != "" {
			return "GET", "/v1/video/discover/" + url.PathEscape(handle) + "?limit=1", nil
		}
		return "GET", "/v1/video/jobs/" + id, nil
	case "video_result_read":
		q := url.Values{}
		for _, k := range []string{"cursor", "limit", "kind", "text_offset", "record_id", "conflict_offset", "text_field"} {
			if v, ok := a[k]; ok {
				q.Set(k, fmt.Sprint(v))
			}
		}
		if handle := argStr(a, "discovery_handle"); handle != "" {
			q.Del("kind")
			return "GET", "/v1/video/discover/" + url.PathEscape(handle) + "?" + q.Encode(), nil
		}
		return "GET", "/v1/video/jobs/" + id + "/result?" + q.Encode(), nil
	case "video_job_cancel":
		return "POST", "/v1/video/jobs/" + id + "/cancel", map[string]any{"reason": argStr(a, "reason")}
	case "video_job_reconcile":
		return "POST", "/v1/video/jobs/reconcile", a
	}
	return "", "", nil
}

// VideoMCPHandler is a thin MCP adapter; it owns no queue, scheduler or job DB.
// A static service key cannot grant a workspace. Each request needs a signed,
// short-lived delegation bound to the configured service and approved connection.
func VideoMCPHandler(db *gorm.DB, cfg Config, engine EngineCaller) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		delegation, err := Verify(cfg.SigningKey, r.Header.Get("X-Flow-Context"), VideoMCPAudience, time.Now())
		if err != nil || delegation.Issuer != cfg.Issuer || delegation.ServiceIdentity != VideoMCPService ||
			delegation.ConnectionID == "" || r.Header.Get("X-Flow-Service-Identity") != VideoMCPService {
			http.Error(w, "invalid video delegation", 401)
			return
		}
		server := mcp.NewServer(&mcp.Implementation{Name: VideoMCPService, Version: "1.0.0"}, nil)
		for _, definition := range videoMCPTools() {
			definition := definition
			server.AddTool(&mcp.Tool{Name: definition.name, Description: definition.description, InputSchema: definition.schema},
				func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
					if delegation.Actor.Type != "user" || delegation.Actor.ID == "" || !delegation.HasScope(definition.scope) {
						return videoMCPError("permission_denied"), nil
					}
					scope, err := ResolveScope(db, delegation.Actor.ID, delegation.WorkspaceID)
					if err != nil || scope.TenantID != delegation.TenantID || !hasScope(scope.Role, definition.scope) {
						return videoMCPError("permission_revoked"), nil
					}
					var conn struct{ Status, AllowedTools string }
					if db.Table("flow_mcp_connections").Select("status, allowed_tools").Where("id = ? AND tenant_id = ? AND workspace_id = ?", delegation.ConnectionID, scope.TenantID, scope.WorkspaceID).Take(&conn).Error != nil || conn.Status != "approved" {
						return videoMCPError("connection_not_approved"), nil
					}
					var allowed []string
					_ = json.Unmarshal([]byte(conn.AllowedTools), &allowed)
					found := false
					for _, n := range allowed {
						if n == definition.name {
							found = true
						}
					}
					if !found {
						return videoMCPError("tool_not_approved"), nil
					}
					a := map[string]any{}
					if json.Unmarshal(req.Params.Arguments, &a) != nil || validateArgs(ToolSpec{Parameters: definition.schema}, a) != nil {
						return videoMCPError("invalid_arguments"), nil
					}
					for k, v := range a {
						if s, ok := v.(string); ok && (len(s) > 2048 || ((k == "source_id" || k == "profile_id" || k == "video_job_id") && strings.TrimSpace(s) == "")) {
							return videoMCPError("invalid_arguments"), nil
						}
					}
					if definition.name == "video_job_reconcile" && argStr(a, "video_job_id") == "" && argStr(a, "idempotency_key") == "" {
						return videoMCPError("recovery_key_required"), nil
					}
					if (definition.name == "video_job_status" || definition.name == "video_result_read") && ((argStr(a, "video_job_id") == "") == (argStr(a, "discovery_handle") == "")) {
						return videoMCPError("exactly_one_job_or_discovery_required"), nil
					}
					key, _ := req.Params.Meta["idempotency_key"].(string)
					if (definition.name == "video_process_start" || definition.name == "video_discover") && key == "" {
						return videoMCPError("idempotency_key_required"), nil
					}
					if n, ok := a["limit"].(float64); ok && (n < 1 || n > 100) {
						return videoMCPError("limit_out_of_range"), nil
					}
					if n, ok := a["deadline_ms"].(float64); ok && (n < 100 || n > 8000) {
						return videoMCPError("deadline_out_of_range"), nil
					}
					method, path, body := videoMCPRoute(definition.name, a)
					raw, _ := json.Marshal(body)
					cctx, cancel := context.WithTimeout(ctx, 8*time.Second)
					defer cancel()
					status, out, err := engine.Do(cctx, scope, delegation.Actor, method, path, key, raw)
					if err != nil {
						return nil, errors.New("video control outcome unknown; reconcile with original idempotency_key")
					}
					var envelope struct {
						Data   json.RawMessage `json:"data"`
						Reason string          `json:"reason"`
					}
					if json.Unmarshal(out, &envelope) != nil {
						return videoMCPError("provider_contract_changed"), nil
					}
					if videoReconcileProvenMissing(status, definition.name, envelope.Reason, a) {
						return &mcp.CallToolResult{StructuredContent: map[string]any{"status": "not_found"}, Content: []mcp.Content{&mcp.TextContent{Text: "No submission exists for this workspace and key."}}}, nil
					}
					if status >= 400 {
						reason := envelope.Reason
						if reason == "" {
							reason = "video_request_failed"
						}
						return videoMCPError(reason), nil
					}
					payload := envelope.Data
					if len(payload) == 0 {
						payload = out
					}
					if len([]rune(string(payload))) > 7800 {
						return videoMCPError("result_page_too_large"), nil
					}
					var value any
					if json.Unmarshal(payload, &value) != nil {
						return videoMCPError("provider_contract_changed"), nil
					}
					if definition.name == "video_job_reconcile" {
						value = map[string]any{"status": "succeeded", "output": value}
					}
					return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "Video control receipt; inspect structuredContent for authoritative state."}}, StructuredContent: value}, nil
				})
		}
		h := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{Stateless: true})
		h.ServeHTTP(w, r)
	})
}

// A downstream object/provider 404 is NOT evidence the original submission
// never happened. Only Loom's scoped request-key lookup can prove that fact.
func videoReconcileProvenMissing(status int, tool, reason string, args map[string]any) bool {
	return status == 404 && tool == "video_job_reconcile" && reason == "VIDEO_SUBMISSION_NOT_FOUND" && argStr(args, "idempotency_key") != "" && argStr(args, "video_job_id") == ""
}

func videoMCPError(reason string) *mcp.CallToolResult {
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: reason}}, StructuredContent: map[string]any{"reason": reason}}
}

func registerVideoMCPRoute(api gin.IRouter, db *gorm.DB, cfg Config, engine EngineCaller) {
	h := VideoMCPHandler(db, cfg, engine)
	api.Any("/internal/flow/video/mcp", gin.WrapH(h))
}
