package flow

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// All three runtimes consume the same committed corpus. Go owns execution-token
// verification and durable command idempotency, not a second manifest importer.
func TestVideoQASharedContractCorpus(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "services", "loom-engine", "validation", "video-knowledge", "shared-contract-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Version         int `json:"version"`
		Key, Permission string
		Now             int64
		Auth            []struct {
			ID, Token string
			Accept    bool
		}
		Idempotency struct {
			Key                  string
			First, Same, Changed json.RawMessage
		}
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if f.Version != 1 || len(f.Auth) != 10 {
		t.Fatal("unexpected shared contract corpus")
	}
	for _, c := range f.Auth {
		t.Run(c.ID, func(t *testing.T) {
			claim, err := Verify([]byte(f.Key), c.Token, "video-knowledge", time.Unix(f.Now, 0))
			accepted := err == nil && claim.HasScope(f.Permission)
			if accepted != c.Accept {
				t.Fatalf("shared token acceptance drift: accepted=%v error=%v", accepted, err)
			}
		})
	}
	db := testDB(t)
	scope, err := ResolveScope(db, "u_alice", "")
	if err != nil {
		t.Fatal(err)
	}
	d := CommandDispatcher{DB: db}
	in := CommandInput{Scope: scope, Actor: Actor{Type: "user", ID: "u_alice"}, Command: "video.process", Method: "POST", Path: "/v1/video/jobs", IdempotencyKey: f.Idempotency.Key, Payload: f.Idempotency.First}
	first, replay, err := d.Enqueue(context.Background(), in)
	if err != nil || replay {
		t.Fatalf("first command: %v %v", replay, err)
	}
	in.Payload = f.Idempotency.Same
	same, replay, err := d.Enqueue(context.Background(), in)
	if err != nil || !replay || same.ID != first.ID {
		t.Fatalf("same command: %v %v", replay, err)
	}
	in.Payload = f.Idempotency.Changed
	if _, _, err := d.Enqueue(context.Background(), in); !errors.Is(err, ErrCommandConflict) {
		t.Fatalf("same key different content: %v", err)
	}
}
