package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"

	"yingce/backend/internal/flow"
)

func TestCanvasWorkflowRunnerFailureLogOnlyContainsSafeClassification(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		err    error
		reason string
		status int
	}{
		{"invalid", flow.ErrInvalid, "invalid", 400},
		{"approval", flow.ErrApprovalRequired, "approval_required", 403},
		{"forbidden", flow.ErrForbidden, "forbidden", 403},
		{"capability", flow.ErrNoCapabilitySnapshot, "capability_snapshot", 403},
		{"tool", flow.ErrToolPermission, "forbidden", 403},
		{"model", flow.ErrModelNotInSnapshot, "capability_snapshot", 403},
		{"tool_snapshot", flow.ErrToolNotInSnapshot, "capability_snapshot", 403},
		{"lease", flow.ErrLeaseHeld, "lease_held", 409},
		{"conflict", flow.ErrCanvasWorkflowConflict, "conflict", 409},
		{"budget", flow.ErrBudgetInsufficient, "budget", 402},
		{"quota", flow.ErrBudgetQuota, "budget", 402},
		{"provider", flow.ErrBudgetProvider, "budget", 402},
		{"parent", flow.ErrBudgetParent, "budget", 402},
		{"missing", flow.ErrNotFound, "not_found", 404},
		{"cancelled", context.Canceled, "cancelled", 500},
		{"deadline", context.DeadlineExceeded, "deadline_exceeded", 500},
		{"unknown", errors.New("private provider response"), "internal", 500},
	}
	const secret = "fixture-secret-never-log"
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var output bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&output, nil))
			wrapped := fmt.Errorf("Authorization: Bearer %s; source subtitle; upstream response: %w", secret, tc.err)
			logCanvasWorkflowRunnerFailure(logger, "server-generated-run-id", wrapped)
			if strings.Contains(output.String(), secret) || strings.Contains(output.String(), "source subtitle") || strings.Contains(output.String(), "private provider response") {
				t.Fatalf("runner diagnostic leaked error contents: %s", output.String())
			}
			var entry map[string]any
			if err := json.Unmarshal(output.Bytes(), &entry); err != nil {
				t.Fatal(err)
			}
			if len(entry) != 6 || entry["run_id"] != "server-generated-run-id" || entry["reason"] != tc.reason || entry["status"] != float64(tc.status) || entry["level"] != "WARN" || entry["msg"] != "canvas workflow runner stopped" {
				t.Fatalf("unexpected diagnostic: %#v", entry)
			}
		})
	}
	var output bytes.Buffer
	logCanvasWorkflowRunnerFailure(slog.New(slog.NewJSONHandler(&output, nil)), "successful-run", nil)
	if output.Len() != 0 {
		t.Fatalf("successful execution emitted a failure diagnostic: %s", output.String())
	}
}
