/**
 * Conformance: confirmation mode is declared by topology (D26, docs/18
 * §correction 6; docs/09 §confirmation-topology).
 * Requirements: AS-TOPO-001, AS-TOPO-002, AS-TOPO-003.
 */
import { describe, expect, it } from "vitest";
import {
  action,
  createAgentSurfaceRegistry,
  createAgentToolset,
  fromJsonSchema,
  requireConfirmation,
  type AgentSurfaceRegistry,
  type AgentTool,
} from "@agent-surface/core";

const CONSUMER = { id: "copilot", kind: "embedded" as const };

function confirmedActionRegistry(): AgentSurfaceRegistry {
  const registry = createAgentSurfaceRegistry({ environment: "test" });
  registry.register({
    type: "conf.drafts",
    description: "draft management",
    actions: {
      discardDraft: action({
        description: "discard the current draft",
        input: fromJsonSchema<Record<string, never>>({
          type: "object",
          properties: {},
          additionalProperties: false,
        }),
        effect: "local-state",
        reversible: false,
        policies: [requireConfirmation()],
        execute: () => {},
      }),
    },
  });
  return registry;
}

function discardTool(tools: AgentTool[]): AgentTool {
  const tool = tools.find((t) => t.name.includes("discardDraft"));
  if (!tool) throw new Error("discardDraft tool missing");
  return tool;
}

/** The invoke pipeline is async: poll microtasks until the record exists. */
async function untilPending(registry: AgentSurfaceRegistry) {
  for (let i = 0; i < 50 && registry.confirmations.pending().length === 0; i++) {
    await Promise.resolve();
  }
  return registry.confirmations.pending();
}

describe("AS-TOPO-001 — no ambiguous global default", () => {
  it("createAgentToolset throws when neither topology nor confirmations is given", () => {
    const registry = confirmedActionRegistry();
    expect(() => createAgentToolset(registry, { consumer: CONSUMER })).toThrow(
      /topology/,
    );
  });
});

describe("AS-TOPO-002 — topology sets the confirmation-mode default", () => {
  it("embedded defaults to wait: one tool call resolves after user approval", async () => {
    const registry = confirmedActionRegistry();
    const toolset = createAgentToolset(registry, { consumer: CONSUMER, topology: "embedded" });
    const pending = discardTool(toolset.tools()).execute({}, { toolCallId: "call_1" });

    // The run is held open on the approval; resolve it as the user.
    const [record] = await untilPending(registry);
    expect(record).toBeDefined();
    registry.confirmations.resolve(record!.confirmationId, { approved: true });

    const result = await pending;
    expect(result.status).toBe("ok");
  });

  it("remote defaults to two-phase: CONFIRMATION_REQUIRED is relayed to the model", async () => {
    const registry = confirmedActionRegistry();
    const toolset = createAgentToolset(registry, { consumer: CONSUMER, topology: "remote" });
    const result = await discardTool(toolset.tools()).execute({}, { toolCallId: "call_2" });
    expect(result.status === "error" && result.error.code).toBe("CONFIRMATION_REQUIRED");
  });

  it("an explicit confirmations mode overrides the topology default", async () => {
    const registry = confirmedActionRegistry();
    const toolset = createAgentToolset(registry, {
      consumer: CONSUMER,
      topology: "remote",
      confirmations: "wait", // explicit opt-in: the adapter owns its timeouts
    });
    const pending = discardTool(toolset.tools()).execute({}, { toolCallId: "call_3" });
    const [record] = await untilPending(registry);
    registry.confirmations.resolve(record!.confirmationId, { approved: true });
    expect((await pending).status).toBe("ok");
  });
});

describe("AS-TOPO-003 — dispose settles pending wait-mode waits deterministically", () => {
  it("a dispose mid-wait returns the pending CONFIRMATION_REQUIRED result as-is", async () => {
    const registry = confirmedActionRegistry();
    const toolset = createAgentToolset(registry, { consumer: CONSUMER, topology: "embedded" });
    const pending = discardTool(toolset.tools()).execute({}, { toolCallId: "call_4" });

    expect(await untilPending(registry)).toHaveLength(1); // the wait is in flight
    toolset.dispose();

    const result = await pending; // settles now — deterministically
    expect(result.status === "error" && result.error.code).toBe("CONFIRMATION_REQUIRED");
  });
});
