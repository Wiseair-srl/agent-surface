/**
 * Performance baselines (directive §7.2): measured numbers replace estimates.
 * Run: pnpm bench — record deltas consciously in docs/02 §budgets.
 */
import { bench, describe } from "vitest";
import {
  action,
  authenticated,
  createAgentSurfaceRegistry,
  fromJsonSchema,
  observation,
  rateLimit,
  type AgentComponentDefinition,
  type AgentSurfaceRegistry,
} from "../src/index.js";
import { canonicalJson, fnv1a64 } from "../src/utils.js";

const Input = fromJsonSchema<{ ids: string[] }>({
  type: "object",
  properties: { ids: { type: "array", items: { type: "string" } } },
  required: ["ids"],
  additionalProperties: false,
});

function definition(i: number): AgentComponentDefinition {
  return {
    type: "bench.widget",
    instanceId: `w${i}`,
    description: "bench widget",
    observations: {
      readState: observation({
        description: "read",
        output: fromJsonSchema<{ n: number }>({
          type: "object",
          properties: { n: { type: "number" } },
          required: ["n"],
        }),
        read: () => ({ n: i }),
      }),
    },
    actions: {
      poke: action({
        description: "poke",
        input: Input,
        effect: "local-state",
        execute: () => {},
      }),
    },
  };
}

function populated(count: number): AgentSurfaceRegistry {
  const registry = createAgentSurfaceRegistry({ environment: "production" });
  for (let i = 0; i < count; i++) registry.register(definition(i));
  return registry;
}

describe("registry lifecycle", () => {
  bench("createAgentSurfaceRegistry()", () => {
    createAgentSurfaceRegistry().dispose();
  });

  for (const count of [10, 100, 1000]) {
    bench(`register+unregister ${count} components`, () => {
      const registry = createAgentSurfaceRegistry({ environment: "production" });
      const handles = [];
      for (let i = 0; i < count; i++) handles.push(registry.register(definition(i)));
      for (const handle of handles) handle.unregister();
      registry.dispose();
    });
  }
});

describe("snapshot projection", () => {
  const r100 = populated(100);
  bench("snapshot() at 100 components (warm descriptor cache)", () => {
    r100.snapshot();
  });
});

describe("invocation overhead (no-op handler)", () => {
  const registry = populated(10);
  let n = 0;
  bench("action invoke end-to-end", async () => {
    await registry.invoke({
      invocationId: `b${n++}`,
      capabilityId: "view:bench.widget.poke",
      instanceId: "w0",
      input: { ids: ["a"] },
    });
  });

  const policied = createAgentSurfaceRegistry({
    environment: "production",
    context: () => ({ user: { id: "u" } }),
    policies: [authenticated(), rateLimit({ limit: 1e9, windowMs: 60_000 })],
  });
  policied.register(definition(0));
  let m = 0;
  bench("action invoke with authorize-chain (2 policies)", async () => {
    await policied.invoke({
      invocationId: `p${m++}`,
      capabilityId: "view:bench.widget.poke",
      instanceId: "w0",
      input: { ids: ["a"] },
    });
  });

  let o = 0;
  bench("observation invoke end-to-end", async () => {
    await registry.invoke({
      invocationId: `o${o++}`,
      capabilityId: "view:bench.widget.readState",
      instanceId: "w0",
    });
  });
});

describe("canonical digest", () => {
  const big = {
    rows: Array.from({ length: 400 }, (_, i) => ({
      id: `device_${i}`,
      name: `Device ${i}`,
      status: i % 2 ? "online" : "offline",
      tags: ["a", "b", "c"],
    })),
  }; // ≈ 32 kB serialized — the input-size ceiling
  bench("canonicalJson + fnv1a64 at ~32 kB input", () => {
    fnv1a64(canonicalJson(big));
  });
});
