// Conformance: AS-TEST-001 (harness as reference consumer: invoke/observe/captureRef/as, matchers hidden!=disabled, semantic snapshots)
import { describe, expect, it } from "vitest";
import {
  action,
  defineAgentComponent,
  fromJsonSchema,
  observation,
} from "@agent-surface/core";
import { createTestSurface, serializeSurfaceSnapshot } from "@agent-surface/testing";
import { matchers } from "@agent-surface/testing/matchers";

expect.extend(matchers);

const anyObject = fromJsonSchema({ type: "object", additionalProperties: true });

function counterComponent(counter: { value: number; mutateOnRead?: boolean }) {
  return defineAgentComponent({
    type: "widget.counter",
    description: "A counter",
    observations: {
      value: observation({
        description: "Current value",
        output: anyObject,
        read: () => ({ value: counter.value }),
      }),
    },
    actions: {
      increment: action({
        description: "Increment",
        input: anyObject,
        effect: "local-state",
        execute: () => {
          counter.value += 1;
        },
      }),
    },
  });
}

describe("createTestSurface (docs/08)", () => {
  it("invoke auto-resolves registrationId from the latest snapshot", async () => {
    const surface = createTestSurface();
    const counter = { value: 0 };
    surface.registry.register(counterComponent(counter));
    const result = await surface.invoke("view:widget.counter.increment", {});
    expect(result.status).toBe("ok");
    expect(counter.value).toBe(1);
    surface.dispose();
  });

  it("observe returns typed output and enforces observation purity", async () => {
    const surface = createTestSurface();
    const counter = { value: 7 };
    surface.registry.register(counterComponent(counter));
    const state = await surface.observe<{ value: number }>("view:widget.counter.value");
    expect(state.value).toBe(7);

    // An observation that mutates the surface is a defect the harness catches.
    const impure = defineAgentComponent({
      type: "widget.impure",
      description: "impure",
      observations: {
        bad: observation({
          description: "mutates the surface while reading",
          output: anyObject,
          read: () => {
            surface.registry.register(
              defineAgentComponent({ type: "widget.sneaky", description: "sneaky" }),
            );
            return {};
          },
        }),
      },
    });
    surface.registry.register(impure);
    await expect(surface.observe("view:widget.impure.bad")).rejects.toThrow(/mutated the surface/);
    surface.dispose();
  });

  it("captureRef + events() support staleness scripting", async () => {
    const surface = createTestSurface();
    const counter = { value: 0 };
    const handle = surface.registry.register(counterComponent(counter));
    const ref = surface.captureRef("view:widget.counter.increment");
    expect(ref.registrationId).toBe(handle.registrationId);
    handle.unregister();
    surface.registry.register(counterComponent(counter));
    const stale = await surface.invoke("view:widget.counter.increment", {}, {
      registrationId: ref.registrationId,
    });
    expect(stale).toFailWith("STALE_CAPABILITY", { reason: "registration-replaced" });
    expect(surface.events().some((e) => e.type === "component-unregistered")).toBe(true);
    surface.dispose();
  });

  it("as() swaps host context mid-test", async () => {
    const surface = createTestSurface({ host: { user: null } });
    surface.registry.register(
      defineAgentComponent({
        type: "widget.gated",
        description: "gated",
        actions: {
          run: action({
            description: "requires user",
            input: anyObject,
            effect: "local-state",
            when: () => true,
            execute: (_input, ctx) => {
              if (!ctx.host.user) throw new Error("no user");
            },
          }),
        },
      }),
    );
    const before = await surface.invoke("view:widget.gated.run", {});
    expect(before.status).toBe("error");
    surface.as({ user: { id: "admin" } });
    const after = await surface.invoke("view:widget.gated.run", {});
    expect(after.status).toBe("ok");
    surface.dispose();
  });

  it("auditLog() exposes the registry's audit trail", async () => {
    const surface = createTestSurface();
    const counter = { value: 0 };
    surface.registry.register(counterComponent(counter));
    await surface.invoke("view:widget.counter.increment", {});
    const types = surface.auditLog().map((e) => e.type);
    expect(types).toContain("registration");
    expect(types).toContain("invocation-settled");
    surface.dispose();
  });
});

describe("matchers", () => {
  it("toExpose vs toExposeUnavailable vs hidden — the distinction is the security model", async () => {
    const surface = createTestSurface();
    const counter = { value: 0 };
    const def = counterComponent(counter);
    def.actions!.gated = action({
      description: "gated",
      input: anyObject,
      effect: "local-state",
      when: () => false,
      unavailableReason: "Not right now",
      execute: () => {},
    });
    surface.registry.register(def);

    expect(surface).toExpose("view:widget.counter.increment");
    expect(surface).toExposeUnavailable("view:widget.counter.gated", { reason: "Not right now" });
    expect(surface).not.toExpose("view:widget.counter.gated"); // disabled ≠ exposed
    expect(surface).not.toExpose("view:widget.counter.ghost"); // hidden/absent
    surface.dispose();
  });

  it("toBeOk / toFailWith assert results directly", async () => {
    const surface = createTestSurface();
    const counter = { value: 0 };
    surface.registry.register(counterComponent(counter));
    expect(await surface.invoke("view:widget.counter.increment", {})).toBeOk();
    expect(await surface.invoke("view:widget.counter.ghost", {})).toFailWith(
      "CAPABILITY_NOT_FOUND",
    );
    surface.dispose();
  });
});

describe("semantic snapshots (docs/08)", () => {
  it("normalizes registrationIds and drops volatility", () => {
    const surface = createTestSurface();
    surface.registry.register(counterComponent({ value: 0 }));
    const normalized = serializeSurfaceSnapshot(surface.snapshot());
    expect(JSON.stringify(normalized)).not.toContain("reg_");
    expect(JSON.stringify(normalized)).not.toContain("srf_");
    expect((normalized.components as Array<{ registrationId: string }>)[0]?.registrationId).toBe(
      "<reg#1>",
    );
    expect(normalized).not.toHaveProperty("surfaceVersion");
    expect(normalized).not.toHaveProperty("capturedAt");
    surface.dispose();
  });

  it("is stable across remounts (fresh registrationIds normalize identically)", () => {
    const surface = createTestSurface();
    const handle = surface.registry.register(counterComponent({ value: 0 }));
    const first = JSON.stringify(serializeSurfaceSnapshot(surface.snapshot()));
    handle.unregister();
    surface.registry.register(counterComponent({ value: 0 }));
    const second = JSON.stringify(serializeSurfaceSnapshot(surface.snapshot()));
    expect(second).toBe(first);
    surface.dispose();
  });

  it("toMatchSurfaceSnapshot records a reviewable artifact", () => {
    const surface = createTestSurface();
    surface.registry.register(counterComponent({ value: 0 }));
    expect(surface).toMatchSurfaceSnapshot();
    surface.dispose();
  });
});
