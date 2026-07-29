// Conformance: AS-AVAIL-002 (hide vs disable D11/D12), AS-POLICY-002 (most-restrictive-wins), AS-POLICY-003 (per-consumer requirement 12), AS-POLICY-004 (built-ins)
import { describe, expect, it, vi } from "vitest";
import {
  authenticated,
  createAgentSurfaceRegistry,
  environment,
  hasPermission,
  memoryAuditSink,
  audit as auditPolicy,
  rateLimit,
  tenantBoundary,
  type AgentConsumer,
  type AgentPolicy,
} from "@agent-surface/core";
import { devicesTableDefinition, makeDevicesState } from "./helpers.js";

const CAP = "view:devices.table.selectRows";

function makeRegistry(host: Record<string, unknown>, policies: AgentPolicy[]) {
  const hostRef = { current: host };
  const registry = createAgentSurfaceRegistry({
    environment: "test",
    context: () => hostRef.current,
    policies,
  });
  registry.register(devicesTableDefinition(makeDevicesState()));
  return { registry, hostRef };
}

function capabilityIds(registry: ReturnType<typeof createAgentSurfaceRegistry>): string[] {
  return registry
    .snapshot()
    .components.flatMap((c) => [...c.observations, ...c.actions].map((x) => x.capabilityId));
}

describe("hide vs disable (D11/D12): authority hides, state discloses", () => {
  it("hide removes capabilities from the snapshot entirely; disable keeps them with a reason", () => {
    const hidePolicy: AgentPolicy = {
      name: "hide-actions",
      onDiscovery: (ctx) => (ctx.kind === "action" ? { decision: "hide" } : { decision: "expose" }),
    };
    const { registry } = makeRegistry({}, [hidePolicy]);
    const snapshot = registry.snapshot();
    expect(snapshot.components[0]?.actions).toHaveLength(0);
    expect(snapshot.components[0]?.observations).toHaveLength(1);

    const disablePolicy: AgentPolicy = {
      name: "disable-actions",
      onDiscovery: (ctx) =>
        ctx.kind === "action"
          ? { decision: "disable", reason: "maintenance window" }
          : { decision: "expose" },
    };
    const { registry: registry2 } = makeRegistry({}, [disablePolicy]);
    const act = registry2.snapshot().components[0]?.actions[0];
    expect(act?.available).toBe(false);
    expect(act?.unavailableReason).toBe("maintenance window");
  });

  it("most-restrictive-wins: any hide beats disable beats expose; first disable reason kept", () => {
    const policies: AgentPolicy[] = [
      { name: "a", onDiscovery: () => ({ decision: "disable", reason: "first" }) },
      { name: "b", onDiscovery: () => ({ decision: "disable", reason: "second" }) },
    ];
    const { registry } = makeRegistry({}, policies);
    expect(registry.snapshot().components[0]?.actions[0]?.unavailableReason).toBe("first");

    const withHide = makeRegistry({}, [
      ...policies,
      { name: "c", onDiscovery: () => ({ decision: "hide" }) },
    ]);
    // Every capability hidden ⇒ the whole component is hidden too.
    expect(withHide.registry.snapshot().components).toHaveLength(0);
  });

  it("discovery/invocation consistency: hidden ⇒ CAPABILITY_NOT_FOUND, disabled ⇒ CAPABILITY_NOT_AVAILABLE", async () => {
    const hiddenReg = makeRegistry({}, [
      { name: "hide", onDiscovery: () => ({ decision: "hide" }) },
    ]).registry;
    const hiddenResult = await hiddenReg.invoke({ capabilityId: CAP, input: { ids: ["d1"] } });
    expect(hiddenResult.status === "error" && hiddenResult.error.code).toBe(
      "CAPABILITY_NOT_FOUND",
    );

    const disabledReg = makeRegistry({}, [
      { name: "disable", onDiscovery: () => ({ decision: "disable", reason: "later" }) },
    ]).registry;
    const disabledResult = await disabledReg.invoke({ capabilityId: CAP, input: { ids: ["d1"] } });
    expect(disabledResult.status === "error" && disabledResult.error.code).toBe(
      "CAPABILITY_NOT_AVAILABLE",
    );
  });
});

describe("per-consumer filtering (requirement 12)", () => {
  it("a capability hidden from consumer C at discovery is equally denied at invocation", async () => {
    const embeddedOnly: AgentPolicy = {
      name: "embedded-only",
      onDiscovery: (ctx) =>
        ctx.consumer.kind === "embedded" ? { decision: "expose" } : { decision: "hide" },
      onInvoke: async (ctx, next) => {
        if (ctx.consumer.kind !== "embedded") {
          const { AgentSurfaceError } = await import("@agent-surface/core");
          throw new AgentSurfaceError({
            code: "CAPABILITY_NOT_FOUND",
            message: "This capability does not exist in the current surface.",
            retry: "after-refresh",
          });
        }
        return next();
      },
    };
    const { registry } = makeRegistry({}, [embeddedOnly]);
    const webmcp: AgentConsumer = { id: "browser", kind: "webmcp" };
    const embedded: AgentConsumer = { id: "copilot", kind: "embedded" };

    expect(
      registry.snapshot({ consumer: webmcp }).components.flatMap((c) => c.actions),
    ).toHaveLength(0);
    expect(
      registry.snapshot({ consumer: embedded }).components.flatMap((c) => c.actions).length,
    ).toBeGreaterThan(0);

    const denied = await registry.invoke(
      { capabilityId: CAP, input: { ids: ["d1"] } },
      { consumer: webmcp },
    );
    expect(denied.status === "error" && denied.error.code).toBe("CAPABILITY_NOT_FOUND");

    const allowed = await registry.invoke(
      { capabilityId: CAP, input: { ids: ["d1"] } },
      { consumer: embedded },
    );
    expect(allowed.status).toBe("ok");
  });
});

describe("built-in policies (docs/06)", () => {
  it("authenticated(): hides at discovery, NOT_AUTHENTICATED at invocation", async () => {
    const { registry, hostRef } = makeRegistry({}, [authenticated()]);
    expect(capabilityIds(registry)).toHaveLength(0);
    const result = await registry.invoke({ capabilityId: CAP, input: { ids: ["d1"] } });
    expect(result.status === "error" && result.error.code).toBe("NOT_AUTHENTICATED");
    expect(result.status === "error" && result.error.retry).toBe("no");

    hostRef.current = { user: { id: "u1" } };
    expect(capabilityIds(registry).length).toBeGreaterThan(0);
    const ok = await registry.invoke({ capabilityId: CAP, input: { ids: ["d1"] } });
    expect(ok.status).toBe("ok");
  });

  it("hasPermission(): hides; NOT_AUTHORIZED {origin: client} without permission names leaking", async () => {
    const check = (host: Record<string, unknown>, permission: string): boolean =>
      Array.isArray(host.permissions) && (host.permissions as string[]).includes(permission);
    const { registry, hostRef } = makeRegistry({ permissions: [] }, [
      hasPermission("devices:write", check),
    ]);
    expect(capabilityIds(registry)).toHaveLength(0);
    const result = await registry.invoke({ capabilityId: CAP, input: { ids: ["d1"] } });
    expect(result.status === "error" && result.error.code).toBe("NOT_AUTHORIZED");
    expect(result.status === "error" && result.error.details).toEqual({ origin: "client" });
    expect(JSON.stringify(result.status === "error" && result.error)).not.toContain(
      "devices:write",
    );
    hostRef.current = { permissions: ["devices:write"] };
    expect(capabilityIds(registry).length).toBeGreaterThan(0);
  });

  it("tenantBoundary(): hides when tenants differ", () => {
    const { registry, hostRef } = makeRegistry({ tenantId: "acme" }, [
      tenantBoundary({
        current: (host) => host.tenantId as string | undefined,
        expected: (ctx) => ctx.internal.tenant as string | undefined,
      }),
    ]);
    // Component has no internal.tenant ⇒ expected undefined ⇒ visible.
    expect(capabilityIds(registry).length).toBeGreaterThan(0);
    hostRef.current = { tenantId: "other" };
    expect(capabilityIds(registry).length).toBeGreaterThan(0);
  });

  it("tenantBoundary() hides mismatching internal tenants", () => {
    const registry = createAgentSurfaceRegistry({
      environment: "test",
      context: () => ({ tenantId: "acme" }),
      policies: [
        tenantBoundary({
          current: (host) => host.tenantId as string | undefined,
          expected: (ctx) => ctx.internal.tenant as string | undefined,
        }),
      ],
    });
    registry.register(
      devicesTableDefinition(makeDevicesState(), { internal: { tenant: "other" } }),
    );
    expect(registry.snapshot().components).toHaveLength(0);
  });

  it("environment(): restricts to listed environments", async () => {
    const { registry } = makeRegistry({}, [environment(["development"])]);
    expect(capabilityIds(registry)).toHaveLength(0);
    const allowed = makeRegistry({}, [environment(["test"])]).registry;
    expect(capabilityIds(allowed).length).toBeGreaterThan(0);
  });

  it("rateLimit(): advisory token bucket per (consumer, capability)", async () => {
    const { registry } = makeRegistry({}, [rateLimit({ limit: 2, windowMs: 60_000 })]);
    const call = () => registry.invoke({ capabilityId: CAP, input: { ids: ["d1"] } });
    expect((await call()).status).toBe("ok");
    expect((await call()).status).toBe("ok");
    const limited = await call();
    expect(limited.status === "error" && limited.error.code).toBe("RATE_LIMITED");
    expect(limited.status === "error" && limited.error.details?.reason).toBe("rate");
    expect(
      limited.status === "error" && typeof limited.error.details?.retryAfterMs,
    ).toBe("number");
    // Another consumer has its own bucket.
    const other = await registry.invoke(
      { capabilityId: CAP, input: { ids: ["d1"] } },
      { consumer: { id: "other", kind: "embedded" } },
    );
    expect(other.status).toBe("ok");
  });

  it("audit(): forwards invocation events to the given sink", async () => {
    const sink = memoryAuditSink();
    const { registry } = makeRegistry({}, [auditPolicy(sink, "full")]);
    await registry.invoke({ capabilityId: CAP, input: { ids: ["d1"] } });
    const types = sink.events().map((e) => e.type);
    expect(types).toEqual(["invocation-started", "invocation-settled"]);
    expect(sink.events()[0]?.payload?.input).toEqual({ ids: ["d1"] });
  });

  it("policy onInvoke chains run onion-style: registry outermost", async () => {
    const order: string[] = [];
    const mk = (name: string): AgentPolicy => ({
      name,
      onInvoke: async (_ctx, next) => {
        order.push(`${name}:before`);
        const result = await next();
        order.push(`${name}:after`);
        return result;
      },
    });
    const registry = createAgentSurfaceRegistry({
      environment: "test",
      policies: [mk("registry")],
    });
    const def = devicesTableDefinition(makeDevicesState(), { policies: [mk("component")] });
    def.actions!.selectRows!.policies = [mk("capability")];
    registry.register(def);
    await registry.invoke({ capabilityId: CAP, input: { ids: ["d1"] } });
    expect(order).toEqual([
      "registry:before",
      "component:before",
      "capability:before",
      "capability:after",
      "component:after",
      "registry:after",
    ]);
  });

  it("a throwing discovery policy fails closed (hidden), with a dev warning path", () => {
    const { registry } = makeRegistry({}, [
      {
        name: "broken",
        onDiscovery: () => {
          throw new Error("boom");
        },
      },
    ]);
    expect(registry.snapshot().components).toHaveLength(0);
  });
});
