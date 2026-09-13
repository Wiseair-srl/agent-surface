// Conformance: AS-GOVERNED-001, AS-GOVERNED-002 (D43).
import { describe, expect, it, vi } from "vitest";
import { createGovernedOrpcAgentBridge, createOrpcAgentManifest, type GovernedDomainOutcome, type PortableDomainCapability } from "../src/index.js";
import { bindAgentProcedure } from "../src/binding.js";
import { createTestSurface } from "@agent-surface/testing";

type Router = { forms: { edit(input: { definitionId: string; title: string }): Promise<{ title: string }> } };
const descriptor: PortableDomainCapability = {
  version: 1, id: "forms.edit", path: ["forms", "edit"], description: "Edit a form",
  sideEffect: "write", requiresApproval: true, contractDigest: "sha256:contract-1",
  inputSchema: { type: "object", properties: { definitionId: { type: "string" }, title: { type: "string" } }, required: ["definitionId", "title"], additionalProperties: false },
};
function setup(outcome: GovernedDomainOutcome) {
  const invoke = vi.fn(async () => outcome);
  const onOutcome = vi.fn();
  const bridge = createGovernedOrpcAgentBridge<Router>({ client: { invoke }, manifest: createOrpcAgentManifest([descriptor]), onOutcome });
  const surface = createTestSurface();
  surface.registry.setProcedureExecutor(bridge.executor);
  surface.registry.register({ type: "forms.editor", description: "Editor", procedures: [bindAgentProcedure(bridge.refs.forms.edit, { bind: () => ({ definitionId: "open-form" }) })] });
  return { surface, bridge, invoke, onOutcome };
}

describe("governed contextual bridge", () => {
  it("AS-GOVERNED-001: generates schema/effect/revision metadata from portable descriptors", () => {
    const manifest = createOrpcAgentManifest([descriptor]);
    expect(manifest.tools["forms.edit"]).toMatchObject({ capabilityId: "forms.edit", contractDigest: "sha256:contract-1", effect: "server-mutation", requiresApproval: true, inputSchema: descriptor.inputSchema });
    expect(() => createOrpcAgentManifest([descriptor, descriptor])).toThrow(/Duplicate/);
    expect(() => createOrpcAgentManifest([{ ...descriptor, path: ["__proto__", "polluted"] }])).toThrow(/Invalid/);
    expect(() => createOrpcAgentManifest([descriptor, { ...descriptor, id: "forms", path: ["forms"] }])).toThrow(/Conflicting/);
    const detached = structuredClone(descriptor);
    const generated = createOrpcAgentManifest([detached]);
    detached.inputSchema.type = "string";
    expect(generated.tools["forms.edit"]!.inputSchema.type).toBe("object");
  });

  it("AS-GOVERNED-001: forwards full locked input and stable identity through the agent client", async () => {
    const { surface, invoke } = setup({ status: "completed", invocationId: "inv-1", executionId: "exec-1", output: { title: "Updated" } });
    const snapshot = surface.snapshot();
    expect(snapshot.procedures[0]).toMatchObject({ requiresApproval: true, confirmation: "optional" });
    expect(snapshot.procedures[0]?.inputSchema.properties).toEqual({ title: { type: "string" } });
    const result = await surface.registry.invoke({ capabilityId: "domain:forms.edit", invocationId: "inv-1", input: { title: "Updated" } });
    expect(result).toMatchObject({ status: "ok", output: { title: "Updated" } });
    expect(invoke).toHaveBeenCalledWith("forms.edit", { definitionId: "open-form", title: "Updated" }, expect.objectContaining({ invocationId: "inv-1", correlationId: "inv-1", contractDigest: "sha256:contract-1" }));
    expect((invoke.mock.calls as unknown[][])[0]?.[2]).not.toHaveProperty("surface");
    surface.registry.dispose();
  });

  it("AS-GOVERNED-002: exposes domain approval distinctly without a local confirmation", async () => {
    const { surface, onOutcome } = setup({ status: "approval-required", invocationId: "inv-1", executionId: "exec-1", approval: { id: "approval-1", expiresAt: "2026-09-14T00:00:00.000Z" } });
    const result = await surface.registry.invoke({ capabilityId: "domain:forms.edit", invocationId: "inv-1", input: { title: "Updated" } });
    expect(result).toMatchObject({ status: "error", error: { code: "DOMAIN_APPROVAL_REQUIRED", retry: "no", details: { invocationId: "inv-1", executionId: "exec-1", approvalId: "approval-1" } } });
    expect(surface.registry.confirmations.pending()).toHaveLength(0);
    expect(onOutcome).toHaveBeenCalledOnce();
    surface.registry.dispose();
  });

  it("AS-GOVERNED-002: a lost response is unknown, never a retryable transport failure", async () => {
    const bridge = createGovernedOrpcAgentBridge<Router>({ manifest: createOrpcAgentManifest([descriptor]), client: { invoke: async () => { throw new TypeError("Network failure with private details"); } } });
    await expect(bridge.refs.forms.edit.call({ definitionId: "open", title: "Updated" }, { invocationId: "inv-1", consumer: { id: "user", kind: "embedded" }, signal: new AbortController().signal })).rejects.toMatchObject({ payload: { code: "DOMAIN_OUTCOME_UNKNOWN", retry: "no", details: { invocationId: "inv-1" } } });
  });

  it("AS-GOVERNED-001: an overridden backend capability ID retains typed router-path references", async () => {
    const invoke = vi.fn(async () => ({ status: "completed" as const, invocationId: "inv-1", executionId: "exec-1", output: { title: "Updated" } }));
    const manifest = createOrpcAgentManifest([{ ...descriptor, id: "form-studio.applyEdit" }]);
    const bridge = createGovernedOrpcAgentBridge<Router>({ manifest, client: { invoke } });
    expect(bridge.refs.forms.edit.id).toBe("domain:forms.edit");
    expect(manifest.tools["forms.edit"]!.capabilityId).toBe("form-studio.applyEdit");
    await bridge.refs.forms.edit.call({ definitionId: "open", title: "Updated" }, { invocationId: "inv-1", consumer: { id: "user", kind: "embedded" }, signal: new AbortController().signal });
    expect(invoke).toHaveBeenCalledWith("form-studio.applyEdit", { definitionId: "open", title: "Updated" }, expect.objectContaining({ invocationId: "inv-1" }));
  });

  it("AS-GOVERNED-002: correlated receipt mismatch is unknown and does not notify success", async () => {
    const { bridge, onOutcome, surface } = setup({ status: "completed", invocationId: "wrong", executionId: "exec-1", output: {} });
    await expect(bridge.refs.forms.edit.call({ definitionId: "open", title: "Updated" }, { invocationId: "inv-1", consumer: { id: "user", kind: "embedded" }, signal: new AbortController().signal })).rejects.toMatchObject({ payload: { code: "DOMAIN_OUTCOME_UNKNOWN" } });
    expect(onOutcome).not.toHaveBeenCalled();
    surface.registry.dispose();
  });
});
