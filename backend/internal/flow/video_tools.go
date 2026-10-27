package flow

import (
	"net/http"
	"net/url"
	"time"
)

func init() {
	Catalog = append(Catalog, ToolSpec{Name: "intel_search_knowledge", Description: "Search only currently published, authorized industry knowledge. Never fall back to unreviewed source material.", Class: "read", Scope: "intel.knowledge.read", Timeout: 10 * time.Second, OutputCap: 12000,
		Parameters: obj([]string{"query"}, map[string]any{"query": tStr, "profile_id": tStr, "limit": tInt, "cursor": tStr}), route: func(a map[string]any) (string, string, any) { return http.MethodPost, "/v1/knowledge/search", a }},
		ToolSpec{Name: "intel_read_knowledge", Description: "Read published knowledge with immutable evidence and current withdrawal checks.", Class: "read", Scope: "intel.knowledge.read", Timeout: 10 * time.Second, OutputCap: 12000,
			Parameters: obj([]string{"knowledge_id"}, map[string]any{"knowledge_id": tStr}), route: func(a map[string]any) (string, string, any) {
				return http.MethodGet, "/v1/knowledge/" + url.PathEscape(argStr(a, "knowledge_id")), nil
			}},
		ToolSpec{Name: "intel_research_video_materials", Description: "Explicit researcher-only access to ready source material. It is unreviewed source claims, not published verified industry knowledge.", Class: "read", Scope: "intel.knowledge.research", Timeout: 10 * time.Second, OutputCap: 16000,
			Parameters: obj([]string{"query"}, map[string]any{"query": tStr, "profile_id": tStr, "limit": tInt, "cursor": tStr}), route: func(a map[string]any) (string, string, any) { return http.MethodPost, "/v1/knowledge/research", a }})
	for _, name := range []string{"intel_search_knowledge", "intel_read_knowledge", "intel_research_video_materials"} {
		topicTools[name] = true
	}
}
