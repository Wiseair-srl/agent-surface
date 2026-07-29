import { usePendingConfirmations } from "@agent-surface/react";

/** The dialog is a REPRESENTATION of policy, not the policy (docs/04):
 *  approving resolves the single-use evidence in core. */
export function ConfirmationHost() {
  const pending = usePendingConfirmations();
  const current = pending[0];
  if (!current) return null;
  return (
    <div className="confirm-backdrop">
      <div className="confirm" role="alertdialog" data-testid="confirmation-dialog">
        <div className="confirm-head">
          <div className="confirm-kicker">Agent requests approval</div>
          <h2 className="confirm-title">Allow this action?</h2>
          <p className="confirm-summary" data-testid="confirmation-summary">
            {current.summary}
          </p>
        </div>
        <div className="confirm-capability">{current.capabilityId} · single-use</div>
        <pre className="confirm-payload">{JSON.stringify(current.input, null, 2)}</pre>
        <div className="confirm-actions">
          <span className="confirm-expiry">
            expires {new Date(current.expiresAt).toLocaleTimeString()}
          </span>
          <button
            className="btn-ghost"
            data-testid="confirmation-deny"
            onClick={() => current.deny("user-declined")}
          >
            Deny
          </button>
          <button
            className="btn-primary"
            data-testid="confirmation-approve"
            onClick={() => current.approve()}
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
