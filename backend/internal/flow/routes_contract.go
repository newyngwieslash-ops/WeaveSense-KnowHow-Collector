package flow

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"yingce/backend/internal/model"

	"github.com/gin-gonic/gin"
)

type proxyFunc func(method, enginePath string) gin.HandlerFunc
type proxyWithFunc func(method, enginePath string, mutate func(body []byte, u *model.User, idem string) ([]byte, error)) gin.HandlerFunc
type proxyCommandFunc func(command, method, enginePath string) gin.HandlerFunc

// directApproval marks a REST monitor save as approved by the signed-in user's own request
// (the agent path gets its approval_id from the approval card instead).
func directApproval(body []byte, u *model.User, idem string) ([]byte, error) {
	if idem == "" {
		return nil, errors.New("X-Idempotency-Key required")
	}
	m := map[string]any{}
	if len(body) > 0 {
		if err := json.Unmarshal(body, &m); err != nil {
			return nil, errors.New("invalid json")
		}
	}
	m["approval_id"] = "user-direct:" + u.ID + ":" + idem
	return json.Marshal(m)
}

// Document reads are short scoped calls, not a browser-to-engine escape hatch.
// Keep range semantics and object visibility in Loom; reject transport-level
// authority injection and oversize bodies before the ordinary signed proxy.
func documentReadBoundary(next gin.HandlerFunc) gin.HandlerFunc {
	return func(c *gin.Context) {
		body, err := io.ReadAll(io.LimitReader(c.Request.Body, (1<<20)+1))
		if err != nil || len(body) > 1<<20 {
			videoReply(c, http.StatusRequestEntityTooLarge, "request_too_large")
			return
		}
		var fields map[string]json.RawMessage
		if json.Unmarshal(body, &fields) != nil || fields == nil {
			videoReply(c, http.StatusBadRequest, "invalid_json")
			return
		}
		for field := range fields {
			switch field {
			case "document_id", "revision", "offset", "max_chars":
			default:
				videoReply(c, http.StatusBadRequest, "untrusted_authority_field")
				return
			}
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
		defer cancel()
		c.Request = c.Request.WithContext(ctx)
		c.Request.Body = io.NopCloser(bytes.NewReader(body))
		next(c)
	}
}

// registerContractRoutes adds the PRD §11.1 routes that were only reachable through agent tools.
func registerContractRoutes(g *gin.RouterGroup, proxy proxyFunc, proxyWith proxyWithFunc, proxyCommand proxyCommandFunc) {
	g.GET("/sources/health", proxy(http.MethodGet, "/v1/sources/health"))
	g.PATCH("/sources/:id", proxy(http.MethodPatch, "/v1/sources/:id"))
	g.POST("/monitors", monitorCreateBoundary(proxyWith(http.MethodPost, "/v1/monitors", directApproval)))
	g.POST("/documents/read", documentReadBoundary(proxy(http.MethodPost, "/v1/documents/read")))
	g.GET("/documents/:id/revisions", proxy(http.MethodGet, "/v1/documents/:id/revisions"))
	g.GET("/documents/:id/revisions/:rev", proxy(http.MethodGet, "/v1/documents/:id/revisions/:rev"))
	g.POST("/research-runs", proxyCommand("research.request", http.MethodPost, "/v1/research-runs?async=1"))
	g.GET("/research-runs/:id", proxy(http.MethodGet, "/v1/research-runs/:id"))
	g.POST("/research-runs/:id/cancel", proxy(http.MethodPost, "/v1/research-runs/:id/cancel"))
	g.POST("/operations/:id/cancel", proxy(http.MethodPost, "/v1/operations/:id/cancel"))
	g.POST("/documents/ocr", proxy(http.MethodPost, "/v1/documents/ocr"))
	g.POST("/documents/asr", proxy(http.MethodPost, "/v1/documents/asr"))
	g.POST("/evidence/compare", proxy(http.MethodPost, "/v1/evidence/compare"))
	g.GET("/terms", proxy(http.MethodGet, "/v1/terms"))
	g.POST("/terms", proxy(http.MethodPost, "/v1/terms"))
	g.POST("/terms/delete", proxy(http.MethodPost, "/v1/terms/delete"))
}
