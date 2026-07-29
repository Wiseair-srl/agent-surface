/**
 * Conformance: queue wait and execution duration are distinct in audit
 * (directive §7.1). Requirement: AS-OBSV-001.
 */
import { describe, expect, it } from "vitest";
import {
  action,
  createAgentSurfaceRegistry,
  fromJsonSchema,
  memoryAuditSink,
} from "@agent-surface/core";

const EmptyInput = fromJsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});

describe("AS-OBSV-001 — queueWaitMs and executionMs are measured separately", () => {
  it("a queued action's audit shows the wait; both show execution time", async () => {
    let clock = 0;
    const sink = memoryAuditSink();
    const registry = createAgentSurfaceRegistry({
      environment: "test",
      audit: sink,
      now: () => clock,
    });
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    registry.register({
      type: "obs.timed",
      description: "timed fixture",
      actions: {
        first: action({
          description: "holds the slot until released",
          input: EmptyInput,
          effect: "local-state",
          execute: async () => {
            await gate;
          },
        }),
        second: action({
          description: "runs after the first releases",
          input: EmptyInput,
          effect: "local-state",
          execute: () => {
            clock += 7; // execution visibly consumes injected time
          },
        }),
      },
    });

    const first = registry.invoke({ capabilityId: "view:obs.timed.first", input: {} });
    const second = registry.invoke({ capabilityId: "view:obs.timed.second", input: {} });
    await Promise.resolve();
    clock += 123; // time passes while `second` waits for the slot
    releaseFirst();
    await Promise.all([first, second]);

    const settled = sink
      .events()
      .filter((e) => e.type === "invocation-settled" && e.capabilityId?.includes("obs.timed"));
    const secondAudit = settled.find((e) => e.capabilityId === "view:obs.timed.second");
    expect(secondAudit?.queueWaitMs).toBe(123);
    expect(secondAudit?.executionMs).toBe(7);
    const firstAudit = settled.find((e) => e.capabilityId === "view:obs.timed.first");
    expect(firstAudit?.queueWaitMs).toBe(0);
    expect(firstAudit?.executionMs).toBeGreaterThanOrEqual(123);
  });
});
