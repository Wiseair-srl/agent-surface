import { useEffect, useState } from "react";
import type { PendingConfirmation } from "@agent-surface/core";
import { useAgentSurface } from "./context.js";

export interface PendingConfirmationView extends PendingConfirmation {
  approve(): void;
  deny(reason?: string): void;
}

/**
 * Reactive list of pending confirmations for host-rendered dialogs. The
 * dialog is representation, not policy: approving calls
 * registry.confirmations.resolve, which mints the single-use evidence
 * (docs/04, docs/06).
 */
export function usePendingConfirmations(): PendingConfirmationView[] {
  const registry = useAgentSurface();
  const [pending, setPending] = useState<PendingConfirmation[]>(() =>
    registry.confirmations.pending(),
  );

  useEffect(() => {
    setPending(registry.confirmations.pending());
    return registry.confirmations.subscribe((next) => {
      setPending(next);
    });
  }, [registry]);

  return pending.map((record) => ({
    ...record,
    approve: () => registry.confirmations.resolve(record.confirmationId, { approved: true }),
    deny: (reason?: string) =>
      registry.confirmations.resolve(record.confirmationId, {
        approved: false,
        ...(reason !== undefined ? { reason } : {}),
      }),
  }));
}
