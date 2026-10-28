package flow

import (
	"context"
	"errors"
	"testing"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

func TestNativeSkillToolReplayRevalidatesFrozenPin(t *testing.T) {
	tools, _, conv, ss := setupP3(t)
	if _, err := InstallSkill(tools.DB, ss.Scope, "u_alice", "periodic-brief", ""); err != nil {
		t.Fatal(err)
	}
	args := map[string]any{"skill_id": "periodic-brief"}
	first, err := tools.Invoke(context.Background(), conv, ss, "u_alice", "same-native-load", "intel_load_skill", args, "")
	if err != nil || first.Status != "succeeded" {
		t.Fatalf("initial load: %+v %v", first, err)
	}
	if err := tools.DB.Model(&model.FlowSkillRunPin{}).Where("tenant_id = ? AND run_id = ? AND skill_id = ?", ss.Scope.TenantID, tools.runKey(conv), "periodic-brief").Update("hash", "invalidated-durable-pin").Error; err != nil {
		t.Fatal(err)
	}
	replayed, err := tools.Invoke(context.Background(), conv, ss, "u_alice", "same-native-load", "intel_load_skill", args, "")
	if err != nil || replayed.Status != "failed" || len(replayed.Output) != 0 || replayed.Replayed {
		t.Fatalf("cached load bypassed current native pin validation: %+v %v", replayed, err)
	}
}

func TestNativeSkillPinFailsClosedOnStorageFailure(t *testing.T) {
	for _, phase := range []string{"read", "create", "scope_collision"} {
		t.Run(phase, func(t *testing.T) {
			db := testDB(t)
			scope, err := ResolveScope(db, "u_alice", "")
			if err != nil {
				t.Fatal(err)
			}
			installed, err := InstallSkill(db, scope, "u_alice", "periodic-brief", "")
			if err != nil {
				t.Fatal(err)
			}
			failure := errors.New("synthetic pin storage failure")
			calls := 0
			callback := func(tx *gorm.DB) {
				if tx.Statement.Schema != nil && tx.Statement.Schema.Table == "flow_skill_run_pins" {
					calls++
					tx.AddError(failure)
				}
			}
			switch phase {
			case "read":
				if err := db.Callback().Query().Before("gorm:query").Register("test:pin-read-failure", callback); err != nil {
					t.Fatal(err)
				}
			case "create":
				if err := db.Callback().Create().Before("gorm:create").Register("test:pin-create-failure", callback); err != nil {
					t.Fatal(err)
				}
			case "scope_collision":
				if err := db.Create(&model.FlowSkillRunPin{RunID: "same-run", SkillID: installed.SkillID, TenantID: "another-tenant", Version: installed.Version, Hash: installed.Hash}).Error; err != nil {
					t.Fatal(err)
				}
			}
			skill, err := LoadSkillForRun(db, scope, "same-run", installed.SkillID)
			if skill.ID != "" || err == nil {
				t.Fatalf("unpersisted or cross-scope pin loaded: %+v %v", skill, err)
			}
			if phase != "scope_collision" && (!errors.Is(err, failure) || calls != 1) {
				t.Fatalf("storage failure not returned once: %v calls=%d", err, calls)
			}
			if phase == "scope_collision" && !errors.Is(err, gorm.ErrRecordNotFound) {
				t.Fatalf("scope collision did not fail closed: %v", err)
			}
		})
	}
}
