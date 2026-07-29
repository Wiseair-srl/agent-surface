import { useEffect, useRef, useState } from "react";
import { usePendingConfirmations } from "@agent-surface/react";
import { AlertTriangle } from "./Icons.js";

/**
 * The one place the app stops and hands the decision back to a person.
 *
 * The dialog is a REPRESENTATION of policy, not the policy (docs/04):
 * approving resolves the single-use evidence in core. So it shows exactly
 * what the evidence will cover — the capability, the resolved input after
 * binding, and how long the grant stays valid — rather than a reassuring
 * summary. The expiry ticks, because a grant that quietly went stale while
 * you were reading is worse than one that says so.
 */

function secondsLeft(expiresAt: string | number | Date): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

/**
 * Core's default summary appends the resolved input ("… — input: {…}"). The
 * payload is rendered in full right below, so the prose keeps the sentence
 * and drops the duplicate JSON.
 */
function sentenceOf(summary: string): string {
  const cut = summary.indexOf(" — input:");
  return cut === -1 ? summary : summary.slice(0, cut);
}

export function ConfirmationHost() {
  const pending = usePendingConfirmations();
  const current = pending[0];
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [remaining, setRemaining] = useState(() =>
    current ? secondsLeft(current.expiresAt) : 0,
  );

  useEffect(() => {
    if (!current) return;
    setRemaining(secondsLeft(current.expiresAt));
    const timer = setInterval(() => setRemaining(secondsLeft(current.expiresAt)), 1000);
    return () => clearInterval(timer);
  }, [current]);

  // Focus the dialog itself, not a button: the approve action is destructive,
  // so nothing here should be one stray Enter away from happening.
  useEffect(() => {
    if (current) dialogRef.current?.focus();
  }, [current]);

  if (!current) return null;

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      current.deny("user-declined");
    }
  };

  return (
    <div className="scrim">
      <div
        className="dialog is-agent"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-summary"
        data-testid="confirmation-dialog"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <div className="dialog-head">
          <div className="dialog-kicker">
            <AlertTriangle size={13} />
            <span>Agent requests approval</span>
          </div>
          <h2 className="dialog-title" id="confirm-title">
            Allow this action?
          </h2>
          <p className="dialog-summary" id="confirm-summary" data-testid="confirmation-summary">
            {sentenceOf(current.summary)}
          </p>
        </div>

        <div className="dialog-meta">
          <span>{current.capabilityId}</span>
          <span>·</span>
          <span>single-use</span>
        </div>
        <pre className="payload">{JSON.stringify(current.input, null, 2)}</pre>

        <div className="dialog-actions">
          <span className="dialog-expiry" data-soon={remaining <= 10}>
            {remaining > 0 ? `expires in ${remaining}s` : "expired"}
          </span>
          <button
            className="btn btn-ghost"
            data-testid="confirmation-deny"
            onClick={() => current.deny("user-declined")}
          >
            Deny
          </button>
          <button
            className="btn btn-primary"
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
