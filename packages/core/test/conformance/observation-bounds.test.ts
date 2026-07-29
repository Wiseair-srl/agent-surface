/**
 * Conformance: bounded observation concurrency (D24, docs/18 §correction 4).
 * Requirements: AS-OBS-001, AS-OBS-002, AS-OBS-003.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentSurfaceRegistry,
  fromJsonSchema,
  observation,
  type AgentConsumer,
  type AgentInvocationResult,
} from "@agent-surface/core";

const A: AgentConsumer = { id: "adapter-a", kind: "embedded" };
const B: AgentConsumer = { id: "adapter-b", kind: "embedded" };

const LIMITS = {
  maxConcurrentObservationsPerConsumer: 2,
  maxConcurrentObservationsTotal: 3,
  maxQueuedObservationsPerConsumer: 1,
};

function slowObservationRegistry() {
  const registry = createAgentSurfaceRegistry({ environment: "test", limits: LIMITS });
  const pendingReads: Array<(value: number) => void> = [];
  let reads = 0;
  registry.register({
    type: "conf.gauge",
    description: "a slow gauge",
    observations: {
      readValue: observation({
        description: "read the gauge (deliberately slow)",
        output: fromJsonSchema<number>({ type: "number" }),
        read: () => {
          reads += 1;
          return new Promise<number>((resolve) => pendingReads.push(resolve));
        },
      }),
    },
  });
  const observe = (consumer: AgentConsumer): Promise<AgentInvocationResult> =>
    registry.invoke({ capabilityId: "view:conf.gauge.readValue" }, { consumer });
  /** Flush enough microtasks for concurrent pipelines to reach dispatch. */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 25; i++) await Promise.resolve();
  };
  const settleOne = async (value = 42): Promise<void> => {
    for (let i = 0; i < 25 && pendingReads.length === 0; i++) await Promise.resolve();
    pendingReads.shift()?.(value);
    await flush();
  };
  return { registry, observe, settleOne, flush, reads: () => reads };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AS-OBS-001 — per-consumer and global limits with a bounded FIFO queue", () => {
  it("per-consumer overflow fails RATE_LIMITED(queue-full) beyond slots + queue", async () => {
    const { registry, observe, reads } = slowObservationRegistry();
    void observe(A); // slot 1
    void observe(A); // slot 2 (per-consumer cap)
    void observe(A); // queued (queue depth 1)
    const p4 = await observe(A); // overflow
    expect(p4.status === "error" && p4.error.code).toBe("RATE_LIMITED");
    expect(p4.status === "error" && p4.error.details?.reason).toBe("queue-full");
    expect(reads()).toBe(2); // only the two slots dispatched
    registry.dispose(); // settle the hanging reads (leak-free teardown)
  });

  it("the global cap gates admission independently of per-consumer room", async () => {
    const { registry, observe, reads } = slowObservationRegistry();
    void observe(A); // total 1 (A:1)
    void observe(A); // total 2 (A:2, per-consumer cap)
    void observe(B); // total 3 (B:1) — global cap reached
    void observe(B); // B has per-consumer room, but total is full ⇒ queued
    const overflowB = await observe(B); // B's queue (depth 1) is full ⇒ overflow
    expect(reads()).toBe(3);
    expect(overflowB.status === "error" && overflowB.error.details?.reason).toBe("queue-full");
    registry.dispose();
  });
});

describe("AS-OBS-002 — a saturated consumer cannot starve another", () => {
  it("consumer B executes while A holds all its slots and queue", async () => {
    const { registry, observe, settleOne, flush, reads } = slowObservationRegistry();
    void observe(A);
    void observe(A);
    void observe(A); // queued for A
    const b = observe(B); // total is 2 running (A) — B admitted immediately
    await flush();
    expect(reads()).toBe(3); // A×2 + B×1 dispatched
    await settleOne(); // resolves in dispatch order (A first)
    await settleOne();
    await settleOne();
    await settleOne();
    expect((await b).status).toBe("ok");
    registry.dispose();
  });
});

describe("AS-OBS-003 — slots release on settlement/timeout; queues drain FIFO; disposal is leak-free", () => {
  it("settlement admits the queued observation (FIFO) and completes it", async () => {
    const { observe, settleOne, flush, reads } = slowObservationRegistry();
    const p1 = observe(A);
    const p2 = observe(A);
    const queued = observe(A);
    await flush();
    expect(reads()).toBe(2);
    await settleOne(); // p1 settles → queued admitted
    expect(reads()).toBe(3);
    await settleOne();
    await settleOne();
    expect((await p1).status).toBe("ok");
    expect((await p2).status).toBe("ok");
    expect((await queued).status).toBe("ok");
  });

  it("a timed-out observation releases its slot", async () => {
    vi.useFakeTimers();
    const { registry, observe, settleOne, reads } = slowObservationRegistry();
    const hung1 = observe(A);
    const hung2 = observe(A);
    void observe(A); // queued
    await vi.advanceTimersByTimeAsync(0); // flush dispatch
    expect(reads()).toBe(2);
    await vi.advanceTimersByTimeAsync(5_001); // default observation timeout
    const r1 = await hung1;
    expect(r1.status === "error" && r1.error.code).toBe("TIMEOUT");
    expect((await hung2).status === "error").toBe(true);
    // Both slots released by the timeouts: the queued read was dispatched.
    expect(reads()).toBe(3);
    await settleOne();
    registry.dispose();
  });

  it("disposal drains queued observations as CANCELLED (no leaked waiters)", async () => {
    const { registry, observe, flush, reads } = slowObservationRegistry();
    void observe(A);
    void observe(A);
    const queued = observe(A); // waiting in the admission queue
    await flush();
    expect(reads()).toBe(2);
    registry.dispose();
    const result = await queued;
    expect(result.status === "error" && result.error.code).toBe("CANCELLED");
    expect(reads()).toBe(2); // the queued read never dispatched
  });
});
