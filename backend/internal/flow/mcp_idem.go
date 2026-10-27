package flow

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"gorm.io/gorm/clause"

	"yingce/backend/internal/model"
)

var (
	errMCPSent = errors.New("mcp call outcome unknown")
	// ErrMCPUnknownOutcome: the previous attempt may have executed remotely and
	// could not be reconciled; the call is not retried blindly.
	ErrMCPUnknownOutcome = errors.New("flow: mcp call outcome unknown; reconciliation pending, not retried")
	ErrMCPKeyConflict    = errors.New("flow: mcp idempotency key reused with different arguments")
)

// ExecuteKeyed runs an MCP tool at most once per (tenant, key):
//   - succeeded: returns the stored output, no new call and no new charge;
//   - unknown (request sent, result lost): reconciles first via the
//     connection's ReconcileTool; re-executes only if the server reports
//     not_found; otherwise stays unknown and returns ErrMCPUnknownOutcome;
//   - failed (definitely not executed): may be retried.
//
// Credits are charged once, when a call first becomes succeeded.
func (g MCPGateway) ExecuteKeyed(ctx context.Context, scope Scope, actorID, connID, tool string, args map[string]any, key string) (string, bool, error) {
	ctx = withMCPDelegate(ctx, scope, Actor{Type: "user", ID: actorID})
	conn, err := g.get(scope, connID)
	if err != nil {
		return "", false, err
	}
	if conn.Status != "approved" {
		return "", false, ErrMCPNotApproved
	}
	if _, ok := g.View(conn).Approved[tool]; !ok {
		return "", false, ErrMCPToolDenied
	}
	if trusted, err := g.trustedService(conn.Endpoint); err != nil {
		return "", false, err
	} else if trusted != nil {
		current, err := ResolveScope(g.DB, actorID, scope.WorkspaceID)
		if err != nil || current.TenantID != scope.TenantID || !hasScope(current.Role, "intel.mcp.use") {
			return "", false, ErrForbidden
		}
		for _, definition := range videoMCPTools() {
			if definition.name == tool && !hasScope(current.Role, definition.scope) {
				return "", false, ErrForbidden
			}
		}
		if tool == "video_job_status" || tool == "video_result_read" {
			// Authorization and withdrawal are current facts; polling and artifact
			// reads may not replay an old receipt after source access is revoked.
			return g.execute(ctx, current, actorID, connID, tool, args, "")
		}
	}
	if key == "" {
		return g.Execute(ctx, scope, actorID, connID, tool, args)
	}
	raw, _ := json.Marshal(args)
	sum := sha256.Sum256(append([]byte(connID+"\x00"+tool+"\x00"), raw...))
	hash := hex.EncodeToString(sum[:])
	row := model.FlowMCPCall{ID: NewID("mc_"), TenantID: scope.TenantID, IdemKey: key, ConnectionID: connID, Tool: tool, ArgsHash: hash, Status: "pending", CreatedAt: g.now(), UpdatedAt: g.now()}
	ins := g.DB.Clauses(clause.OnConflict{DoNothing: true}).Create(&row)
	if ins.Error != nil {
		return "", false, ins.Error
	}
	if ins.RowsAffected == 0 {
		row = model.FlowMCPCall{}
		if err := g.DB.First(&row, "tenant_id = ? AND idem_key = ?", scope.TenantID, key).Error; err != nil {
			return "", false, err
		}
		if row.ArgsHash != hash {
			return "", false, ErrMCPKeyConflict
		}
		switch row.Status {
		case "succeeded":
			return row.Output, row.Truncated, nil
		case "pending", StatusReconciliation:
			found, out, err := g.reconcile(ctx, scope, row)
			if err != nil {
				return "", false, err
			}
			if found {
				return out, false, nil
			}
		}
		// failed, or reconciled as not executed: retry under the same key.
		g.DB.Model(&model.FlowMCPCall{}).Where("id = ?", row.ID).Updates(map[string]any{"status": "pending", "updated_at": g.now()})
	}
	g.DB.Model(&model.FlowMCPCall{}).Where("id = ?", row.ID).Update("attempts", row.Attempts+1)
	out, truncated, err := g.execute(ctx, scope, actorID, connID, tool, args, key)
	switch {
	case err == nil:
		g.DB.Model(&model.FlowMCPCall{}).Where("id = ?", row.ID).Updates(map[string]any{"status": "succeeded", "output": out, "truncated": truncated, "billed": true, "updated_at": g.now()})
		return out, truncated, nil
	case errors.Is(err, errMCPSent):
		CountMCPError("unknown_outcome")
		g.DB.Model(&model.FlowMCPCall{}).Where("id = ?", row.ID).Updates(map[string]any{"status": StatusReconciliation, "updated_at": g.now()})
		return "", false, fmt.Errorf("%w (%v)", ErrMCPUnknownOutcome, err)
	default:
		CountMCPError(mcpErrorKind(err))
		g.DB.Model(&model.FlowMCPCall{}).Where("id = ?", row.ID).Updates(map[string]any{"status": "failed", "updated_at": g.now()})
		return "", false, err
	}
}

// reconcile asks the server what happened to an unknown call. found=true means
// it executed: the stored row becomes succeeded and is charged exactly once.
func (g MCPGateway) reconcile(ctx context.Context, scope Scope, row model.FlowMCPCall) (bool, string, error) {
	c, err := g.get(scope, row.ConnectionID)
	if err != nil {
		return false, "", err
	}
	v := g.View(c)
	ap, approved := v.Approved[v.CostRule.ReconcileTool]
	if c.Status != "approved" || v.CostRule.ReconcileTool == "" || !approved {
		return false, "", ErrMCPUnknownOutcome
	}
	cctx, cancel := context.WithTimeout(ctx, time.Duration(c.TimeoutMS)*time.Millisecond)
	defer cancel()
	cs, secret, err := g.session(cctx, c)
	if err != nil {
		return false, "", ErrMCPUnknownOutcome
	}
	defer cs.Close()
	live, err := discoverTools(cctx, cs)
	if err != nil {
		return false, "", ErrMCPUnknownOutcome
	}
	if tool, ok := live[v.CostRule.ReconcileTool]; !ok || tool.Hash != ap.Hash {
		g.DB.Model(&c).Updates(map[string]any{"status": "needs_reapproval", "status_reason": "reconcile schema changed", "version": c.Version + 1, "updated_at": g.now()})
		g.InvalidateCache(c.TenantID, c.ID)
		return false, "", ErrMCPSchemaDrift
	}
	res, err := cs.CallTool(cctx, &mcp.CallToolParams{Name: v.CostRule.ReconcileTool, Arguments: map[string]any{"idempotency_key": row.IdemKey}})
	if err != nil || res.IsError {
		return false, "", ErrMCPUnknownOutcome
	}
	var st struct {
		Status string          `json:"status"`
		Output json.RawMessage `json:"output"`
	}
	if json.Unmarshal([]byte(mcpResultText(res)), &st) != nil {
		return false, "", ErrMCPUnknownOutcome
	}
	switch st.Status {
	case "succeeded":
		out := string(st.Output)
		var text string
		if json.Unmarshal(st.Output, &text) == nil {
			out = text
		}
		out = redact(out, secret)
		if len([]rune(out)) > c.OutputCap {
			return false, "", ErrMCPUnknownOutcome
		}
		upd := g.DB.Model(&model.FlowMCPCall{}).Where("id = ? AND status IN ('pending','reconciliation_required')", row.ID).
			Updates(map[string]any{"status": "succeeded", "output": out, "billed": true, "updated_at": g.now()})
		if upd.RowsAffected == 1 {
			g.usage(c, row.Tool, "reconcile", "succeeded", g.now(), len(out), v.CostRule.PerCallCredits)
		}
		return true, out, nil
	case "not_found":
		return false, "", nil
	}
	return false, "", ErrMCPUnknownOutcome
}

func mcpErrorKind(err error) string {
	switch {
	case errors.Is(err, ErrMCPSchemaDrift):
		return "schema_drift"
	case errors.Is(err, ErrMCPBudget):
		return "budget_blocked"
	case errors.Is(err, ErrMCPToolDenied):
		return "denied"
	default:
		return "call_failed"
	}
}
