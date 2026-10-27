package flow

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"yingce/backend/internal/model"
)

// Lawful input is a separate streaming user action, never a model/MCP tool.
// Loom verifies the immutable declared hash, MIME, length and original grant;
// the host neither chooses an object key nor buffers media in its job database.
func registerVideoUpload(g *gin.RouterGroup, cfg Config, scoped func(*gin.Context) (Scope, *model.User, bool)) {
	registerVideoMedia(g, cfg, scoped)
	g.PUT("/video/jobs/:id/input", func(c *gin.Context) {
		scope, user, ok := scoped(c)
		if !ok {
			return
		}
		if !hasScope(scope.Role, "intel.video.process") {
			videoReply(c, 403, "permission_denied")
			return
		}
		if !cfg.Enabled() {
			videoReply(c, 503, "loom_unavailable")
			return
		}
		jobID := c.Param("id")
		if len(jobID) == 0 || len(jobID) > 160 || strings.ContainsAny(jobID, "/\\.\x00") {
			videoReply(c, 400, "invalid_video_job_id")
			return
		}
		length := c.Request.ContentLength
		if length <= 0 {
			videoReply(c, 411, "content_length_required")
			return
		}
		if length > 2<<30 {
			videoReply(c, 413, "input_too_large")
			return
		}
		mime := c.GetHeader("Content-Type")
		if mime == "" || len(mime) > 160 || strings.ContainsAny(mime, "\r\n") {
			videoReply(c, 400, "content_type_required")
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 120*time.Second)
		defer cancel()
		token, err := Sign(cfg.SigningKey, ExecutionContext{Issuer: cfg.Issuer, Audience: cfg.Audience, TenantID: scope.TenantID, WorkspaceID: scope.WorkspaceID, Actor: Actor{Type: "user", ID: user.ID}, Scopes: []string{"intel.video.process"}, JobID: jobID, PolicyVersion: "video_lawful_input_v1"}, time.Now(), 2*time.Minute)
		if err != nil {
			videoReply(c, 503, "upload_authority_unavailable")
			return
		}
		body := http.MaxBytesReader(c.Writer, c.Request.Body, length)
		req, err := http.NewRequestWithContext(ctx, http.MethodPut, cfg.EngineURL+"/v1/video/jobs/"+url.PathEscape(jobID)+"/input", body)
		if err != nil {
			videoReply(c, 502, "upload_reconciliation_required")
			return
		}
		req.ContentLength = length
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", mime)
		client := &http.Client{Timeout: 120 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return ErrEgressBlocked }}
		response, err := client.Do(req)
		if err != nil {
			videoReply(c, 502, "upload_reconciliation_required")
			return
		}
		defer response.Body.Close()
		out, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
		if err != nil || len(out) > 1<<20 {
			videoReply(c, 502, "upload_reconciliation_required")
			return
		}
		c.Data(response.StatusCode, "application/json", out)
	})
}

var videoMediaObjectID = regexp.MustCompile(`^[a-f0-9]{32}$`)
var videoSingleRange = regexp.MustCompile(`^bytes=([0-9]+-[0-9]*|-[0-9]+)$`)

func registerVideoMedia(g *gin.RouterGroup, cfg Config, scoped func(*gin.Context) (Scope, *model.User, bool)) {
	g.GET("/video/jobs/:id/media/:object_id", func(c *gin.Context) {
		scope, user, ok := scoped(c)
		if !ok {
			return
		}
		if !hasScope(scope.Role, "intel.video.read") {
			videoReply(c, 403, "permission_denied")
			return
		}
		if !cfg.Enabled() {
			videoReply(c, 503, "loom_unavailable")
			return
		}
		jobID, objectID := c.Param("id"), c.Param("object_id")
		if len(jobID) == 0 || len(jobID) > 160 || strings.ContainsAny(jobID, "/\\.\x00") || !videoMediaObjectID.MatchString(objectID) {
			videoReply(c, 400, "invalid_media_identity")
			return
		}
		rangeHeader := c.GetHeader("Range")
		if rangeHeader != "" && (!videoSingleRange.MatchString(rangeHeader) || len(rangeHeader) > 100) {
			videoReply(c, 416, "single_byte_range_required")
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 120*time.Second)
		defer cancel()
		token, err := Sign(cfg.SigningKey, ExecutionContext{Issuer: cfg.Issuer, Audience: cfg.Audience, TenantID: scope.TenantID, WorkspaceID: scope.WorkspaceID, Actor: Actor{Type: "user", ID: user.ID}, Scopes: []string{"intel.video.read"}, JobID: jobID, PolicyVersion: "video_media_read_v1"}, time.Now(), 2*time.Minute)
		if err != nil {
			videoReply(c, 503, "media_authority_unavailable")
			return
		}
		req, err := http.NewRequestWithContext(ctx, "GET", cfg.EngineURL+"/v1/video/jobs/"+url.PathEscape(jobID)+"/media/"+objectID, nil)
		if err != nil {
			videoReply(c, 502, "media_unavailable")
			return
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Accept-Encoding", "identity")
		if rangeHeader != "" {
			req.Header.Set("Range", rangeHeader)
		}
		client := &http.Client{Timeout: 120 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return ErrEgressBlocked }}
		resp, err := client.Do(req)
		if err != nil {
			videoReply(c, 502, "media_unavailable")
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 && resp.StatusCode != 206 {
			out, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			if err != nil {
				videoReply(c, 502, "media_unavailable")
				return
			}
			c.Data(resp.StatusCode, "application/json", out)
			return
		}
		if resp.ContentLength < 0 || resp.ContentLength > 2<<30 {
			videoReply(c, 502, "invalid_media_length")
			return
		}
		for _, header := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag"} {
			if value := resp.Header.Get(header); value != "" {
				c.Header(header, value)
			}
		}
		c.Header("Cache-Control", "private, no-store")
		c.Header("X-Content-Type-Options", "nosniff")
		c.Status(resp.StatusCode)
		_, _ = io.Copy(c.Writer, io.LimitReader(resp.Body, resp.ContentLength))
	})
}
