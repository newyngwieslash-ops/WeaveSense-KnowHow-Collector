package flow

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestVideoQATrustedMCPRedirectCannotForwardDelegation(t *testing.T) {
	for _, status := range []int{301, 302, 303, 307, 308} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var targetCalls, sourceCalls atomic.Int32
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { targetCalls.Add(1); w.WriteHeader(204) }))
			defer target.Close()
			source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				sourceCalls.Add(1)
				claim, err := Verify(key, r.Header.Get("X-Flow-Context"), VideoMCPAudience, time.Now())
				if err != nil || claim.ServiceIdentity != VideoMCPService || claim.ConnectionID == "" || claim.Actor.ID != "u_alice" {
					t.Error("trusted MCP request lacks actual scoped delegation")
				}
				http.Redirect(w, r, target.URL+"/steal", status)
			}))
			defer source.Close()
			db := testDB(t)
			scope, err := ResolveScope(db, "u_alice", "")
			if err != nil {
				t.Fatal(err)
			}
			cfg := Config{SigningKey: key, Issuer: "flow-platform", Audience: "loom-engine", TTL: MaxTokenTTL}
			gateway := MCPGateway{DB: db, InternalConfig: &cfg, TrustedServices: []TrustedMCPService{{Endpoint: source.URL + "/mcp", ServiceIdentity: VideoMCPService, Audience: VideoMCPAudience, Addresses: []string{"127.0.0.1"}, AllowHTTP: true}}}
			conn, err := gateway.Create(scope, "u_alice", MCPConnectionInput{Name: "Synthetic redirecting fixed service", Endpoint: source.URL + "/mcp"})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if _, err := gateway.Approve(ctx, scope, conn.ID, "u_alice", []string{"video_discover"}); err == nil {
				t.Fatal("trusted redirect unexpectedly approved")
			}
			if sourceCalls.Load() == 0 || targetCalls.Load() != 0 {
				t.Fatalf("fixed service redirect escaped: source=%d target=%d", sourceCalls.Load(), targetCalls.Load())
			}
			if len(gateway.AgentTools(scope)) != 0 {
				t.Fatal("redirecting unapproved source exposed callable tools")
			}
		})
	}
}
