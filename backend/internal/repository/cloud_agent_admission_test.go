package repository

import (
	"errors"
	"path/filepath"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"yingce/backend/internal/database"
	"yingce/backend/internal/model"
)

func TestEnsureCloudAgentRetriesStaleWALSnapshot(t *testing.T) {
	for _, revoke := range []bool{false, true} {
		name := "same_identity"
		if revoke {
			name = "revocation_rechecked"
		}
		t.Run(name, func(t *testing.T) {
			db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "admission.db")+"?_journal_mode=WAL&_busy_timeout=5000"), &gorm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			if err := database.ConfigurePool(db); err != nil {
				t.Fatal(err)
			}
			sqlDB, err := db.DB()
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = sqlDB.Close() })
			if err := db.AutoMigrate(&model.CloudAgentExecution{}, &model.Task{}, &model.FlowAgentConversation{}); err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&model.Task{ID: "root", UserID: "user", InputJSON: "{}"}).Error; err != nil {
				t.Fatal(err)
			}
			attempts := 0
			// The projection read has already fixed this transaction's snapshot.
			// A different connection commits before INSERT, deterministically
			// reproducing SQLITE_BUSY_SNAPSHOT rather than relying on scheduling.
			if err := db.Callback().Create().Before("gorm:create").Register("test:stale_admission_snapshot", func(tx *gorm.DB) {
				if tx.Statement.Table != "cloud_agent_executions" {
					return
				}
				attempts++
				if attempts != 1 {
					return
				}
				value := "unrelated_writer"
				if revoke {
					value = videoContentRevoked
				}
				if err := db.Model(&model.Task{}).Where("id = ?", "root").Update("error", value).Error; err != nil {
					tx.AddError(err)
				}
			}); err != nil {
				t.Fatal(err)
			}
			run := model.CloudAgentExecution{ID: "root", UserID: "user", StateJSON: "{}", Status: "running", Revision: 1}
			err = New(db).EnsureCloudAgent(&run)
			wantCount, wantAttempts := int64(1), 2
			if revoke {
				wantCount, wantAttempts = 0, 1
				if !errors.Is(err, ErrVideoContentUnavailable) {
					t.Fatalf("want revocation failure after retry, got: %v", err)
				}
				if run.ConversationID != "" || !run.CreatedAt.IsZero() || !run.UpdatedAt.IsZero() {
					t.Fatalf("rolled-back insert mutated the caller: %+v", run)
				}
			} else if err != nil {
				t.Fatalf("stale snapshot did not recover: %v", err)
			}
			if attempts != wantAttempts {
				t.Fatalf("create attempts = %d, want %d", attempts, wantAttempts)
			}
			var count int64
			if err := db.Model(&model.CloudAgentExecution{}).Count(&count).Error; err != nil {
				t.Fatal(err)
			}
			if count != wantCount {
				t.Fatalf("execution count = %d, want %d", count, wantCount)
			}
		})
	}
}
