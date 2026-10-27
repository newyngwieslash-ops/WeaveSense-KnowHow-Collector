package flow

import (
	"context"
	"encoding/json"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

// The platform is an identity/transport boundary. Loom remains the only job,
// profile, knowledge and publication authority for every entry point.
func registerVideoRoutes(g *gin.RouterGroup, db *gorm.DB, engine EngineCaller, cfg Config, scoped func(*gin.Context) (Scope, *model.User, bool)) {
	registerVideoSkillInstall(g, db, engine, scoped)
	registerVideoUpload(g, cfg, scoped)
	type route struct{ method, path, scope string }
	routes := []route{
		{"GET", "/video/metrics", "intel.video.read"},
		{"PATCH", "/schedules/:id", "intel.schedules.write"},
		{"GET", "/video/profiles", "intel.video.read"}, {"POST", "/video/profiles", "intel.profiles.write"},
		{"GET", "/video/profiles/:id", "intel.video.read"}, {"PATCH", "/video/profiles/:id", "intel.profiles.write"},
		{"POST", "/video/discover", "intel.video.process"},
		{"GET", "/video/discover/:id", "intel.video.read"},
		{"POST", "/video/sources/:id/backfill", "intel.video.process"},
		{"GET", "/video/jobs", "intel.video.read"}, {"POST", "/video/jobs", "intel.video.process"},
		{"POST", "/video/jobs/reconcile", "intel.video.process"},
		{"GET", "/video/jobs/:id", "intel.video.read"}, {"GET", "/video/jobs/:id/result", "intel.video.read"},
		{"GET", "/video/jobs/:id/artifacts", "intel.video.read"},
		{"POST", "/video/jobs/:id/cancel", "intel.video.process"}, {"POST", "/video/jobs/:id/retry", "intel.video.process"},
		{"POST", "/video/jobs/:id/repair", "intel.video.process"},
		{"POST", "/video/jobs/:id/reconcile", "intel.video.process"},
		{"POST", "/video/jobs/:id/corrections", "intel.knowledge.review"},
		{"GET", "/knowledge", "intel.knowledge.read"}, {"POST", "/knowledge", "intel.knowledge.write"},
		{"GET", "/knowledge/extractions", "intel.knowledge.research"}, {"POST", "/knowledge/extractions", "intel.knowledge.write"},
		{"GET", "/knowledge/extractions/:id", "intel.knowledge.research"}, {"POST", "/knowledge/extractions/:id/retry", "intel.knowledge.write"},
		{"POST", "/knowledge/origins", "intel.knowledge.review"},
		{"GET", "/knowledge/origin-candidates", "intel.knowledge.research"},
		{"POST", "/knowledge/origin-candidates/:id/review", "intel.knowledge.review"},
		{"POST", "/knowledge/search", "intel.knowledge.read"}, {"POST", "/knowledge/research", "intel.knowledge.research"},
		{"POST", "/knowledge/batch-review", "intel.knowledge.review"},
		{"POST", "/video/retention", "intel.sources.write"},
		{"POST", "/video/retention/preview", "intel.sources.write"},
		{"POST", "/video/retention/batch", "intel.sources.write"},
		{"GET", "/knowledge/:id", "intel.knowledge.read"}, {"PATCH", "/knowledge/:id", "intel.knowledge.write"},
		{"POST", "/knowledge/:id/review", "intel.knowledge.review"}, {"POST", "/knowledge/:id/publish", "intel.knowledge.publish"},
		{"POST", "/knowledge/:id/withdraw", "intel.knowledge.publish"},
		{"GET", "/video/skill-candidates", "intel.knowledge.research"}, {"POST", "/video/skill-candidates", "intel.skills.release"},
		{"POST", "/video/skill-candidates/:id/evaluation-request", "intel.skills.release"},
		{"GET", "/video/skill-candidates/:id", "intel.knowledge.research"},
		{"POST", "/video/skill-candidates/:id/review", "intel.skills.release"}, {"POST", "/video/skill-candidates/:id/export", "intel.skills.release"},
	}
	for _, rt := range routes {
		rt := rt
		g.Handle(rt.method, rt.path, func(c *gin.Context) {
			s, u, ok := scoped(c)
			if !ok {
				return
			}
			if !hasScope(s.Role, rt.scope) {
				videoReply(c, 403, "permission_denied")
				return
			}
			if !cfg.Enabled() {
				videoReply(c, 503, "loom_unavailable")
				return
			}
			body, err := io.ReadAll(io.LimitReader(c.Request.Body, (1<<20)+1))
			if err != nil || len(body) > 1<<20 {
				videoReply(c, 413, "request_too_large")
				return
			}
			if len(body) > 0 {
				var fields map[string]json.RawMessage
				if json.Unmarshal(body, &fields) != nil || fields == nil {
					videoReply(c, 400, "invalid_json")
					return
				}
				for _, key := range []string{"tenant", "tenant_id", "workspace", "workspace_id", "actor", "grant", "scopes", "_meta", "callback", "endpoint", "cookie", "api_key"} {
					if _, present := fields[key]; present {
						videoReply(c, 400, "untrusted_authority_field")
						return
					}
				}
			}
			idem := c.GetHeader("X-Idempotency-Key")
			if rt.method != "GET" && (strings.HasPrefix(rt.path, "/video/") || strings.HasPrefix(rt.path, "/knowledge/origin-candidates/")) && idem == "" {
				videoReply(c, 400, "idempotency_key_required")
				return
			}
			path := "/v1" + rt.path
			for _, p := range c.Params {
				path = strings.ReplaceAll(path, ":"+p.Key, url.PathEscape(p.Value))
			}
			if c.Request.URL.RawQuery != "" {
				path += "?" + c.Request.URL.RawQuery
			}
			ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
			defer cancel()
			status, out, err := engine.Do(ctx, s, Actor{Type: "user", ID: u.ID}, rt.method, path, idem, body)
			if err != nil {
				videoReply(c, 502, "reconciliation_required")
				return
			}
			c.Data(status, "application/json", out)
		})
	}
}

func videoReply(c *gin.Context, status int, reason string) {
	c.JSON(status, gin.H{"code": status, "data": nil, "msg": reason, "reason": reason})
}
