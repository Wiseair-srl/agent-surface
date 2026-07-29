/**
 * Conformance: navigation settlement is independent of owner unmount timing
 * (D23, docs/18 §correction 3; race name: navigation-commit-then-owner-unmount).
 * Requirements: AS-NAV-001, AS-NAV-002, AS-NAV-003, AS-NAV-004.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  action,
  createAgentSurfaceRegistry,
  fromJsonSchema,
  type AgentRegistrationHandle,
} from "@agent-surface/core";

const GoToSchema = fromJsonSchema<{ to: string }>({
  type: "object",
  properties: { to: { type: "string" } },
  required: ["to"],
  additionalProperties: false,
});

function navRegistry(execute: (input: { to: string }, ctx: { signal: AbortSignal }) => unknown) {
  const registry = createAgentSurfaceRegistry({ environment: "test" });
  const handle = registry.register({
    type: "app.navigation",
    description: "top-level navigation",
    actions: {
      goTo: action({
        description: "navigate to a section",
        input: GoToSchema,
        effect: "navigation",
        execute: (input, ctx) => execute(input, ctx) as undefined,
      }),
    },
  });
  return { registry, handle };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AS-NAV-001 — navigation-commit-then-owner-unmount settles ok", () => {
  it("synchronous commit + unmount in the same task reports ok", async () => {
    let handle!: AgentRegistrationHandle;
    const { registry, handle: h } = navRegistry(() => {
      // Router accepts synchronously and the route change unmounts the owner.
      handle.unregister();
    });
    handle = h;
    const result = await registry.invoke({
      capabilityId: "view:app.navigation.goTo",
      input: { to: "/reports" },
    });
    expect(result.status).toBe("ok");
    expect(result.surfaceChanged).toBe(true); // the agent should re-discover
  });

  it("async commit resolving AFTER the unmount still reports ok", async () => {
    let handle!: AgentRegistrationHandle;
    const { registry, handle: h } = navRegistry(async () => {
      handle.unregister(); // owner unmounts while the router is committing
      await Promise.resolve();
      await Promise.resolve();
      // router acceptance resolves the handler afterwards
    });
    handle = h;
    const result = await registry.invoke({
      capabilityId: "view:app.navigation.goTo",
      input: { to: "/reports" },
    });
    expect(result.status).toBe("ok");
  });
});

describe("AS-NAV-002 — rejection before commit is a typed failure", () => {
  it("a router refusal (no unmount) settles EXECUTION_FAILED", async () => {
    const { registry } = navRegistry(() => {
      throw new Error("route guard refused");
    });
    const result = await registry.invoke({
      capabilityId: "view:app.navigation.goTo",
      input: { to: "/forbidden" },
    });
    expect(result.status === "error" && result.error.code).toBe("EXECUTION_FAILED");
  });

  it("a handler abandoning the transition after unmount-abort settles CANCELLED", async () => {
    let handle!: AgentRegistrationHandle;
    const { registry, handle: h } = navRegistry(async (_input, ctx) => {
      handle.unregister(); // aborts ctx.signal, does NOT settle (D23)
      await Promise.resolve();
      if (ctx.signal.aborted) throw new Error("transition abandoned");
    });
    handle = h;
    const result = await registry.invoke({
      capabilityId: "view:app.navigation.goTo",
      input: { to: "/reports" },
    });
    expect(result.status === "error" && result.error.code).toBe("CANCELLED");
  });
});

describe("AS-NAV-003 — unmounted before dispatch is still COMPONENT_UNMOUNTED", () => {
  it("invoking after unregister fails COMPONENT_UNMOUNTED", async () => {
    const { registry, handle } = navRegistry(() => {});
    handle.unregister();
    const result = await registry.invoke({
      capabilityId: "view:app.navigation.goTo",
      input: { to: "/reports" },
    });
    expect(result.status === "error" && result.error.code).toBe("COMPONENT_UNMOUNTED");
  });
});

describe("AS-NAV-004 — a timeout cannot overwrite an accepted navigation", () => {
  it("handler resolution settles first; the later timeout tick is inert", async () => {
    vi.useFakeTimers();
    let handle!: AgentRegistrationHandle;
    const { registry, handle: h } = navRegistry(
      () =>
        new Promise<void>((resolve) => {
          handle.unregister();
          setTimeout(resolve, 10); // router accepts 10 ms later
        }),
    );
    handle = h;
    const pending = registry.invoke(
      { capabilityId: "view:app.navigation.goTo", input: { to: "/reports" } },
      { timeoutMs: 5_000 },
    );
    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;
    expect(result.status).toBe("ok");
    // Advancing beyond the timeout budget changes nothing (single settle).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(result.status).toBe("ok");
  });

  it("a navigation that never settles still times out (bounded)", async () => {
    vi.useFakeTimers();
    let handle!: AgentRegistrationHandle;
    const { registry, handle: h } = navRegistry(
      () =>
        new Promise<void>(() => {
          handle.unregister(); // abort only — handler hangs forever
        }),
    );
    handle = h;
    const pending = registry.invoke(
      { capabilityId: "view:app.navigation.goTo", input: { to: "/reports" } },
      { timeoutMs: 1_000 },
    );
    await vi.advanceTimersByTimeAsync(1_001);
    const result = await pending;
    expect(result.status === "error" && result.error.code).toBe("TIMEOUT");
  });
});
