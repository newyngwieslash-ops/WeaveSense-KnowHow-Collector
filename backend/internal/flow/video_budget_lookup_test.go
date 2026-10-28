package flow

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"yingce/backend/internal/model"
)

func TestVideoBudgetLookupRecoversLostReceiptAfterGrantRevocationWithoutSpending(t *testing.T) {
	db := testDB(t)
	sc, _ := ResolveScope(db, "u_alice", "")
	bob, _ := ResolveScope(db, "u_bob", "")
	fund(t, Billing{DB: db}, "u_alice", 10000)
	cfg := Config{SigningKey: []byte("0123456789abcdef0123456789abcdef"), Issuer: "flow-platform"}
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterP5Routes(router.Group("/api"), db, cfg, func(*gin.Context) (*model.User, error) { return nil, nil }, nil)
	claim := ExecutionContext{Issuer: "loom-engine", Audience: cfg.Issuer, TenantID: sc.TenantID, WorkspaceID: sc.WorkspaceID,
		Actor: Actor{"service_principal", "loom-engine"}, Scopes: []string{"flow.budget.lookup"}, PolicyVersion: "test"}
	call := func(path string, ctx ExecutionContext, body any) (int, map[string]any) {
		t.Helper()
		token, err := Sign(cfg.SigningKey, ctx, time.Now(), time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(body)
		request := httptest.NewRequest(http.MethodPost, "/api/internal/flow/budget/"+path, bytes.NewReader(raw))
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		var out map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return response.Code, out
	}
	reserve := map[string]any{"grant_actor": "user:u_alice", "workspace_id": sc.WorkspaceID, "key": "video:frozen-fingerprint:budget:0", "amount_micro": 6000, "ref_id": "vjob_original"}
	code, response := call("reserve", claim, reserve)
	if code != http.StatusOK {
		t.Fatalf("reserve: %d %+v", code, response)
	}
	id := response["data"].(map[string]any)["reservation_id"]
	var held model.FlowBudgetReservation
	if err := db.First(&held, "id = ?", id).Error; err != nil || held.Note != "schedule-workspace:"+sc.WorkspaceID {
		t.Fatalf("scope binding must commit with hold: %+v %v", held, err)
	}
	lookup := map[string]any{"workspace_id": sc.WorkspaceID, "key": reserve["key"], "ref_id": reserve["ref_id"]}
	if err := db.Model(&model.Membership{}).Where("user_id = ?", "u_alice").Update("status", "revoked").Error; err != nil {
		t.Fatal(err)
	}
	if code, _ = call("reserve", claim, reserve); code != http.StatusForbidden {
		t.Fatalf("revoked grant must still be unable to reserve: %d", code)
	}
	counts := func() []int64 {
		t.Helper()
		var values []int64
		for _, table := range []any{&model.FlowBudgetReservation{}, &model.FlowBillingAccount{}, &model.CreditLedgerEntry{}} {
			var count int64
			if err := db.Model(table).Count(&count).Error; err != nil {
				t.Fatal(err)
			}
			values = append(values, count)
		}
		account := credit(Billing{DB: db}, "u_alice")
		return append(values, account.AvailableMicrocredits, account.ReservedMicrocredits)
	}
	before, _ := json.Marshal(counts())
	if code, response = call("lookup", claim, lookup); code != http.StatusOK || response["data"].(map[string]any)["reservation_id"] != id {
		t.Fatalf("trusted read-only recovery must survive grant revocation: %d %+v", code, response)
	}
	for _, item := range []struct {
		name string
		ctx  ExecutionContext
		body map[string]any
		want int
	}{
		{"wrong_ref", claim, map[string]any{"workspace_id": sc.WorkspaceID, "key": reserve["key"], "ref_id": "other-job"}, 403},
		{"missing_key", claim, map[string]any{"workspace_id": sc.WorkspaceID, "key": "never-reserved", "ref_id": reserve["ref_id"]}, 200},
		{"wrong_workspace", claim, map[string]any{"workspace_id": bob.WorkspaceID, "key": reserve["key"], "ref_id": reserve["ref_id"]}, 403},
		{"reject_amount", claim, map[string]any{"workspace_id": sc.WorkspaceID, "key": reserve["key"], "ref_id": reserve["ref_id"], "amount_micro": 9000}, 400},
	} {
		t.Run(item.name, func(t *testing.T) {
			status, out := call("lookup", item.ctx, item.body)
			if status != item.want || out["data"] != nil {
				t.Fatalf("lookup must not return another hold: %d %+v", status, out)
			}
		})
	}
	for _, mutation := range []func(*ExecutionContext){
		func(c *ExecutionContext) { c.Scopes = []string{"intel.collect"} },
		func(c *ExecutionContext) { c.Actor.ID = "other-service" },
		func(c *ExecutionContext) { c.Issuer = "other-issuer" },
		func(c *ExecutionContext) { c.TenantID = bob.TenantID },
		func(c *ExecutionContext) { c.JobID = "other-job" },
	} {
		ctx := claim
		mutation(&ctx)
		if code, out := call("lookup", ctx, lookup); code != http.StatusForbidden || out["data"] != nil {
			t.Fatalf("untrusted/mismatched accounting claim: %d %+v", code, out)
		}
	}
	foreign := claim
	foreign.TenantID, foreign.WorkspaceID = bob.TenantID, bob.WorkspaceID
	if code, out := call("lookup", foreign, map[string]any{"workspace_id": bob.WorkspaceID, "key": reserve["key"], "ref_id": reserve["ref_id"]}); code != 200 || out["data"] != nil {
		t.Fatalf("other tenant must see no receipt and must not create an account: %d %+v", code, out)
	}
	after, _ := json.Marshal(counts())
	if !bytes.Equal(before, after) {
		t.Fatalf("lookup mutated accounting: before=%s after=%s", before, after)
	}
	// A recovered receipt can be closed even when its original actor is revoked.
	if code, out := call("close", claim, map[string]any{"reservation_id": id, "outcome": "release"}); code != 200 || out["data"].(map[string]any)["status"] != "released" {
		t.Fatalf("recover then release: %d %+v", code, out)
	}
	if code, out := call("lookup", claim, lookup); code != 200 || out["data"].(map[string]any)["status"] != "released" {
		t.Fatalf("closed receipt remains queryable: %d %+v", code, out)
	}
	if credit(Billing{DB: db}, "u_alice").AvailableMicrocredits != 10000 {
		t.Fatal("recovery release failed to refund original hold")
	}
	for _, change := range []map[string]any{{"purpose": "unrelated"}, {"parent_id": "other-parent"}, {"note": ""}, {"note": "schedule-workspace:another-workspace"}} {
		original := map[string]any{"purpose": "schedule_window", "parent_id": "", "note": "schedule-workspace:" + sc.WorkspaceID}
		for key, value := range change {
			original[key] = value
		}
		if err := db.Model(&held).Updates(original).Error; err != nil {
			t.Fatal(err)
		}
		want := http.StatusForbidden
		if value, exists := change["note"]; exists && value == "" {
			want = http.StatusConflict
		}
		if code, out := call("lookup", claim, lookup); code != want || out["data"] != nil {
			t.Fatalf("unbound or different-purpose hold must not leak: %d %+v", code, out)
		}
	}
	if err := db.Model(&model.Membership{}).Where("user_id = ?", "u_alice").Update("status", "active").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&held).Updates(map[string]any{"purpose": "schedule_window", "parent_id": "", "note": "schedule-workspace:" + sc.WorkspaceID}).Error; err != nil {
		t.Fatal(err)
	}
	for _, change := range []map[string]any{{"ref_id": "wrong-ref"}, {"amount_micro": 7000}} {
		body := make(map[string]any)
		for key, value := range reserve {
			body[key] = value
		}
		for key, value := range change {
			body[key] = value
		}
		if code, out := call("reserve", claim, body); code != http.StatusConflict || out["data"] != nil {
			t.Fatalf("reservation key reuse must not alter its original identity: %d %+v", code, out)
		}
	}
	before, _ = json.Marshal(counts())
	if err := db.Callback().Update().Before("gorm:update").Register("fail_test_schedule_binding", func(tx *gorm.DB) {
		if tx.Statement.Table == "flow_budget_reservations" {
			if values, ok := tx.Statement.Dest.(map[string]interface{}); ok && values["note"] != nil {
				tx.AddError(errors.New("injected scope binding persistence failure"))
			}
		}
	}); err != nil {
		t.Fatal(err)
	}
	defer db.Callback().Update().Remove("fail_test_schedule_binding")
	if code, out := call("reserve", claim, map[string]any{"grant_actor": "user:u_alice", "workspace_id": sc.WorkspaceID, "key": "fresh-binding-failure", "ref_id": "vjob_new", "amount_micro": 6000}); code != 500 || out["data"] != nil {
		t.Fatalf("binding failure must fail the entire hold: %d %+v", code, out)
	}
	after, _ = json.Marshal(counts())
	if !bytes.Equal(before, after) {
		t.Fatalf("failed binding left an unscoped hold/accounting entry: before=%s after=%s", before, after)
	}
}
