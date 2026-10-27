package flow

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestVideoProjectionPinsJournalGenesisAndSameSequenceHash(t *testing.T) {
	db := testDB(t)
	scope, _ := ResolveScope(db, "u_alice", "")
	page := videoProjectionPage{JournalID: "journal", GenesisHash: strings.Repeat("a", 64), HeadHash: strings.Repeat("a", 64)}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claim, err := Verify(key, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), "loom-engine", time.Now())
		if err != nil || claim.Actor.ID != "video-projection-reader" || claim.WorkspaceID != scope.WorkspaceID || !claim.HasScope("intel.video.read") {
			w.WriteHeader(403)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": page})
	}))
	defer server.Close()
	cfg := Config{EngineURL: server.URL, SigningKey: key, Issuer: "flow-platform", Audience: "loom-engine", TTL: MaxTokenTTL}
	if err := ReconcileVideoProjection(context.Background(), db, cfg, scope); err != nil {
		t.Fatal(err)
	}
	page.HeadHash = strings.Repeat("b", 64)
	if err := ReconcileVideoProjection(context.Background(), db, cfg, scope); !errors.Is(err, ErrVideoProjectionUnavailable) {
		t.Fatal("same sequence/different hash trusted", err)
	}
	page.HeadSequence = 1
	page.GenesisHash = strings.Repeat("c", 64)
	if err := ReconcileVideoProjection(context.Background(), db, cfg, scope); !errors.Is(err, ErrVideoProjectionUnavailable) {
		t.Fatal("replacement journal generation trusted", err)
	}
	page.HeadSequence = 0
	page.GenesisHash = strings.Repeat("a", 64)
	page.HeadHash = page.GenesisHash
	if err := ReconcileVideoProjection(context.Background(), db, cfg, scope); err != nil {
		t.Fatal("failed replay changed trusted watermark", err)
	}
}
