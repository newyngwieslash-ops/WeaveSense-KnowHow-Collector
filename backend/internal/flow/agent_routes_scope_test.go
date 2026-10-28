package flow

import (
	"context"
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

func TestAgentConversationLoadUsesRequestScopedDatabase(t *testing.T) {
	db := testDB(t)
	ss, err := ResolveSubject(db, "u_alice", AgentSubject{Kind: SubjectWorkspace})
	if err != nil {
		t.Fatal(err)
	}
	conv, err := (Conversations{DB: db}).Create("u_alice", ss, "request-scope regression")
	if err != nil {
		t.Fatal(err)
	}
	type scopedKey struct{}
	queries := 0
	if err := db.Callback().Query().Before("gorm:query").Register("test:require-conversation-request-scope", func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Table == "flow_agent_conversations" {
			queries++
			if tx.Statement.Context.Value(scopedKey{}) != true {
				tx.AddError(errors.New("conversation read bypassed request transaction"))
			}
		}
	}); err != nil {
		t.Fatal(err)
	}
	r := gin.New()
	api := r.Group("/api", func(c *gin.Context) {
		c.Set(reqDBKey, db.WithContext(context.WithValue(c.Request.Context(), scopedKey{}, true)))
		c.Next()
	})
	RegisterAgentRoutes(api, db, nil, func(*gin.Context) (*model.User, error) { return &model.User{ID: "u_alice"}, nil })
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/agent/conversations/"+conv.ID+"/messages", nil))
	if w.Code != 200 || queries == 0 {
		t.Fatalf("scoped conversation read: status=%d queries=%d body=%s", w.Code, queries, w.Body.String())
	}
}
