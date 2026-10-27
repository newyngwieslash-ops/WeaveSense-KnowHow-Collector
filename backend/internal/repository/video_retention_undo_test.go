package repository

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

func TestNativeVideoRetentionUndoSnapshotBarrier(t *testing.T) {
	r, db := nativeRetentionFixture(t)
	if err := db.AutoMigrate(&model.CloudAgentCanvasMutation{}, &model.CanvasProject{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.FlowAgentConversation{}).Where("id = ?", "flow-video").Update("evidence_scope", "{}").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.CloudAgentCanvasMutation{ID: "undo", RunID: "native-root", UserID: "user", CanvasID: "canvas", Status: "applied", BeforeJSON: "SECRET"}).Error; err != nil {
		t.Fatal(err)
	}
	unavailable := errors.New("authoritative projection unavailable")
	r.SetVideoProjectionGuard(func(context.Context, *gorm.DB, string, string) error { return unavailable })
	checks := map[string]func() error{
		"latest by run":    func() error { _, err := r.LatestCloudAgentCanvasMutation("user", "native-root"); return err },
		"latest by canvas": func() error { _, err := r.LatestCloudAgentCanvasMutationForCanvas("user", "canvas"); return err },
		"mutation chain":   func() error { _, err := r.CloudAgentCanvasMutationChain("user", "native-root", "canvas"); return err },
		"late snapshot": func() error {
			return r.CreateCloudAgentCanvasMutation(&model.CloudAgentCanvasMutation{ID: "late", RunID: "native-root", UserID: "user", CanvasID: "canvas", Status: "applied", BeforeJSON: "LATE SECRET"})
		},
		"late undo mark": func() error { return r.MarkCloudAgentCanvasMutationUndone("user", "native-root", "undo", time.Now()) },
	}
	for name, check := range checks {
		t.Run(name, func(t *testing.T) {
			if err := check(); !errors.Is(err, unavailable) {
				t.Fatalf("undo retention barrier missing: %v", err)
			}
		})
	}
}

func TestNativeVideoRetentionUndoPurgePreservesUnrelatedCanvas(t *testing.T) {
	for _, erase := range []bool{false, true} {
		t.Run(map[bool]string{false: "revoked", true: "erased"}[erase], func(t *testing.T) {
			r, db := nativeRetentionFixture(t)
			if err := db.AutoMigrate(&model.CloudAgentCanvasMutation{}, &model.CanvasProject{}); err != nil {
				t.Fatal(err)
			}
			canvasBody := `{"nodes":[{"id":"user-drawing","content":"keep my drawing"}]}`
			for _, row := range []any{
				&model.CanvasProject{ID: "canvas", UserID: "user", PayloadJSON: canvasBody},
				&model.CloudAgentExecution{ID: "unrelated", UserID: "user", ConversationID: "unrelated", Status: "completed", StateJSON: `{}`},
				&model.CloudAgentCanvasMutation{ID: "affected", RunID: "native-root", UserID: "user", CanvasID: "canvas", Status: "applied", BeforeJSON: "SECRET", CreatedAt: time.Now().Add(-time.Hour)},
				&model.CloudAgentCanvasMutation{ID: "unrelated", RunID: "unrelated", UserID: "user", CanvasID: "canvas", Status: "applied", BeforeJSON: "KEEP", CreatedAt: time.Now()},
				&model.CloudAgentCanvasMutation{ID: "foreign", RunID: "native-root", UserID: "other-user", CanvasID: "canvas", Status: "applied", BeforeJSON: "KEEP FOREIGN"},
			} {
				if err := db.Create(row).Error; err != nil {
					t.Fatal(err)
				}
			}
			if err := db.Transaction(func(tx *gorm.DB) error {
				return PurgeVideoConversationCaches(tx, "tenant", "workspace", []string{"flow-video"}, erase)
			}); err != nil {
				t.Fatal(err)
			}
			var affected model.CloudAgentCanvasMutation
			if err := db.Take(&affected, "id = ?", "affected").Error; err != nil {
				t.Fatal(err)
			}
			if affected.Status != "not_undoable" || (erase && affected.BeforeJSON != "") {
				t.Fatalf("affected undo retained: %+v", affected)
			}
			if !erase && affected.BeforeJSON != "SECRET" {
				t.Fatal("revocation unexpectedly erased retained snapshot")
			}
			latest, err := r.LatestCloudAgentCanvasMutationForCanvas("user", "canvas")
			if err != nil || latest.ID != "unrelated" || latest.BeforeJSON != "KEEP" {
				t.Fatalf("unrelated latest snapshot unavailable: %+v %v", latest, err)
			}
			var canvas model.CanvasProject
			db.Take(&canvas, "id = ?", "canvas")
			if canvas.PayloadJSON != canvasBody {
				t.Fatal("user Canvas drawings changed")
			}
			var foreign model.CloudAgentCanvasMutation
			db.Take(&foreign, "id = ?", "foreign")
			if !strings.Contains(foreign.BeforeJSON, "KEEP FOREIGN") || foreign.Status != "applied" {
				t.Fatal("foreign undo snapshot changed")
			}
			if err := r.CreateCloudAgentCanvasMutation(&model.CloudAgentCanvasMutation{ID: "late", RunID: "native-root", UserID: "user", CanvasID: "canvas", Status: "applied", BeforeJSON: "LATE SECRET"}); err == nil {
				t.Fatal("late writer recreated undo snapshot")
			}
		})
	}
}

func TestNativeVideoRetentionUndoWriteRechecksAfterFreshBarrier(t *testing.T) {
	for _, mark := range []bool{false, true} {
		t.Run(map[bool]string{false: "create", true: "mark"}[mark], func(t *testing.T) {
			r, db := nativeRetentionFixture(t)
			if err := db.AutoMigrate(&model.CloudAgentCanvasMutation{}); err != nil {
				t.Fatal(err)
			}
			if err := db.Model(&model.FlowAgentConversation{}).Where("id = ?", "flow-video").Update("evidence_scope", "{}").Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&model.CloudAgentCanvasMutation{ID: "undo", UserID: "user", RunID: "native-root", Status: "applied", BeforeJSON: "SECRET"}).Error; err != nil {
				t.Fatal(err)
			}
			// Simulate another revocation completing between lineage resolution
			// and the write transaction. The write must reload the persisted fence.
			r.SetVideoProjectionGuard(func(context.Context, *gorm.DB, string, string) error {
				return db.Model(&model.CloudAgentExecution{}).Where("id = ?", "native-root").Update("failure_message", videoContentErased).Error
			})
			var err error
			if mark {
				err = r.MarkCloudAgentCanvasMutationUndone("user", "native-root", "undo", time.Now())
			} else {
				err = r.CreateCloudAgentCanvasMutation(&model.CloudAgentCanvasMutation{ID: "late", UserID: "user", RunID: "native-root", Status: "applied", BeforeJSON: "LATE SECRET"})
			}
			if !errors.Is(err, ErrVideoContentUnavailable) {
				t.Fatalf("late write crossed persisted fence: %v", err)
			}
			var row model.CloudAgentCanvasMutation
			if err := db.Take(&row, "id = ?", "undo").Error; err != nil {
				t.Fatal(err)
			}
			if row.Status != "applied" {
				t.Fatal("late undo marked receipt despite retention fence")
			}
			var n int64
			db.Model(&model.CloudAgentCanvasMutation{}).Where("id = ?", "late").Count(&n)
			if n != 0 {
				t.Fatal("late snapshot persisted")
			}
		})
	}
}
