import type {
  AgentActionContext,
  AgentActionDefinition,
  AgentComponentDefinition,
  AgentObservationDefinition,
  AgentProcedureBinding,
  AgentReadContext,
  PreconditionFailure,
} from "./definition.js";
import { AgentSurfaceDefinitionError } from "./errors.js";
import type { AgentPolicy } from "./policy.js";
import type { AgentSchema } from "./schema.js";
import type { AgentConcurrency, AgentEffect, JsonSchema, JsonValue } from "./types.js";
import { deepFreeze, jsonDeepEqual } from "./utils.js";
import { sha256 } from "./sha256.js";

/** Contract format emitted by @agent-surface/compiler. */
export const CAPABILITY_CONTRACT_FORMAT_VERSION = 5 as const;

export type CapabilityContractKind = "observation" | "action" | "procedure" | "external";

export interface CapabilityPolicyAttachment {
  name: string;
  phase?: "discovery" | "authorize" | "invoke";
}

export interface CapabilityContractEntry {
  declarationId: string;
  capabilityId: string;
  kind: CapabilityContractKind;
  description: string;
  effect: AgentEffect;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  confirmation?: "never" | "optional" | "required";
  policies?: CapabilityPolicyAttachment[];
  tags?: string[];
  contractHash: string;
  targets: string[];
  origin: string;
}

/**
 * How a dependency's capabilities entered this manifest.
 *
 * Two facts are recorded separately because they answer different questions.
 * `contractDigest` is *integrity*: what the dependency actually contributed to
 * this build. `authorization` is *consent*: what the consumer approved. A
 * dependency that changes its contract moves the first and not the second, and
 * the build fails until a human updates the allow list.
 */
export interface ExternalContractAttribution {
  /** npm package name — the stable key an allow list is written against. */
  package: string;
  /** Where the contribution came from, relative to the build root. */
  source: string;
  /** How the dependency contributed. */
  route: "sidecar" | "source";
  /** sha256 of the contribution as this build computed it. */
  contractDigest: string;
  /** What the consumer explicitly approved. */
  authorization: {
    mode: "pinned";
    expectedDigest: string;
  };
}

export interface CapabilityContractManifest {
  formatVersion: typeof CAPABILITY_CONTRACT_FORMAT_VERSION;
  compilerVersion: string;
  targets: string[];
  capabilities: CapabilityContractEntry[];
  externalContracts: ExternalContractAttribution[];
  completeness: { status: "proven" };
  /** sha256 of the canonical manifest payload without this field. */
  hash: string;
}

export interface CompiledCapabilityToken {
  manifestHash: string;
  declarationId: string;
  capabilityId: string;
  contractHash: string;
}

export interface CompiledComponentProvenance {
  manifestHash: string;
  declarationId: string;
  capabilities: Record<string, CompiledCapabilityToken>;
}

declare const CAPABILITY_AUTHORITY_TYPE: unique symbol;

/** Immutable runtime source of truth. Only objects minted here are accepted. */
export interface CapabilityAuthority {
  readonly manifest: CapabilityContractManifest;
  readonly [CAPABILITY_AUTHORITY_TYPE]: true;
}

interface CapabilityAuthorityState {
  manifest: CapabilityContractManifest;
  index: Map<string, CapabilityContractEntry>;
}

const authorityStates = new WeakMap<object, CapabilityAuthorityState>();
const componentBindingProofs = new WeakMap<object, CompiledComponentProvenance>();
const capabilityContractProofs = new WeakMap<object, CompiledCapabilityToken>();
const externalToolProofs = new WeakMap<object, CompiledCapabilityToken>();

let unsafeAuthorityTestMode = false;

/** @internal Repository-only test seam. Not exported from the package root. */
export function enableUnsafeAuthorityTestMode(): void {
  unsafeAuthorityTestMode = true;
}

/** @internal */
export function disableUnsafeAuthorityTestMode(): void {
  unsafeAuthorityTestMode = false;
}

/** @internal */
export function isUnsafeAuthorityTestMode(): boolean {
  return unsafeAuthorityTestMode;
}

export interface AgentObservationContract<TOut extends JsonValue> {
  description: string;
  output: AgentSchema<TOut>;
  meta?: Record<string, JsonValue>;
  timeoutMs?: number;
  policies?: CapabilityPolicyAttachment[];
  tags?: string[];
}

export interface AgentActionContract<
  TIn extends JsonValue,
  TOut extends JsonValue | void = void,
> {
  description: string;
  input: AgentSchema<TIn>;
  output?: AgentSchema<Exclude<TOut, void>>;
  effect: "local-state" | "navigation";
  idempotent?: boolean;
  reversible?: boolean;
  confirmation?: "never" | "optional" | "required";
  audit?: "none" | "metadata" | "full";
  meta?: Record<string, JsonValue>;
  timeoutMs?: number;
  concurrency?: AgentConcurrency;
  policies?: CapabilityPolicyAttachment[];
  tags?: string[];
}

export function observationContract<TOut extends JsonValue>(
  contract: AgentObservationContract<TOut>,
): AgentObservationContract<TOut> {
  return contract;
}

export function actionContract<TIn extends JsonValue, TOut extends JsonValue | void = void>(
  contract: AgentActionContract<TIn, TOut>,
): AgentActionContract<TIn, TOut> {
  return contract;
}

type ObservationBindings<C> = C extends AgentObservationContract<infer TOut>
  ? {
      read(ctx: AgentReadContext): TOut | Promise<TOut>;
      when?: () => boolean;
      unavailableReason?: string | (() => string);
      policies?: AgentPolicy[];
    }
  : never;

type ActionBindings<C> = C extends AgentActionContract<infer TIn, infer TOut>
  ? {
      execute(input: TIn, ctx: AgentActionContext): TOut | Promise<TOut>;
      when?: () => boolean;
      unavailableReason?: string | (() => string);
      precondition?(input: TIn, ctx: AgentReadContext): void | PreconditionFailure;
      policies?: AgentPolicy[];
    }
  : never;

export interface AgentComponentContractDefinition<
  TObservations extends Record<string, AgentObservationContract<any>> = Record<
    string,
    AgentObservationContract<any>
  >,
  TActions extends Record<string, AgentActionContract<any, any>> = Record<
    string,
    AgentActionContract<any, any>
  >,
> {
  type: string;
  description: string;
  meta?: Record<string, JsonValue>;
  origin?: string;
  priority?: number;
  policies?: CapabilityPolicyAttachment[];
  tags?: string[];
  observations?: TObservations;
  actions?: TActions;
}

export interface AgentComponentRuntimeBindings<
  TObservations extends Record<string, AgentObservationContract<any>>,
  TActions extends Record<string, AgentActionContract<any, any>>,
> {
  instanceId?: string;
  parent?: { type: string; instanceId?: string };
  internal?: Record<string, unknown>;
  enabled?: boolean;
  policies?: AgentPolicy[];
  observations?: { [K in keyof TObservations]: ObservationBindings<TObservations[K]> };
  actions?: { [K in keyof TActions]: ActionBindings<TActions[K]> };
  procedures?: AgentProcedureBinding<any, any>[];
}

export interface AgentComponentContract<
  TObservations extends Record<string, AgentObservationContract<any>>,
  TActions extends Record<string, AgentActionContract<any, any>>,
> extends AgentComponentContractDefinition<TObservations, TActions> {
  readonly kind: "agent-component-contract";
  bind(bindings: AgentComponentRuntimeBindings<TObservations, TActions>): AgentComponentDefinition;
}

/**
 * Compiler macro. The second argument is injected by @agent-surface/compiler;
 * author code must never supply it.
 */
export function defineAgentComponentContract<
  TObservations extends Record<string, AgentObservationContract<any>> = Record<never, never>,
  TActions extends Record<string, AgentActionContract<any, any>> = Record<never, never>,
>(
  definition: AgentComponentContractDefinition<TObservations, TActions>,
): AgentComponentContract<TObservations, TActions>;
export function defineAgentComponentContract<
  TObservations extends Record<string, AgentObservationContract<any>> = Record<never, never>,
  TActions extends Record<string, AgentActionContract<any, any>> = Record<never, never>,
>(
  definition: AgentComponentContractDefinition<TObservations, TActions>,
  compiled?: CompiledComponentProvenance,
): AgentComponentContract<TObservations, TActions> {
  const contract: AgentComponentContract<TObservations, TActions> = {
    ...definition,
    kind: "agent-component-contract",
    bind(bindings) {
      const observations: Record<string, AgentObservationDefinition<any>> = {};
      for (const [name, authored] of Object.entries(definition.observations ?? {})) {
        const runtime = bindings.observations?.[name];
        if (!runtime?.read) {
          throw new AgentSurfaceDefinitionError(
            "INVALID_DEFINITION",
            `contract "${definition.type}" observation "${name}" has no runtime binding`,
          );
        }
        observations[name] = {
          description: authored.description,
          output: authored.output,
          read: runtime.read,
          ...(authored.meta ? { meta: authored.meta } : {}),
          ...(authored.timeoutMs !== undefined ? { timeoutMs: authored.timeoutMs } : {}),
          ...(runtime.when ? { when: runtime.when } : {}),
          ...(runtime.unavailableReason ? { unavailableReason: runtime.unavailableReason } : {}),
          ...(runtime.policies ? { policies: runtime.policies } : {}),
        };
      }
      const actions: Record<string, AgentActionDefinition<any, any>> = {};
      for (const [name, authored] of Object.entries(definition.actions ?? {})) {
        const runtime = bindings.actions?.[name];
        if (!runtime?.execute) {
          throw new AgentSurfaceDefinitionError(
            "INVALID_DEFINITION",
            `contract "${definition.type}" action "${name}" has no runtime binding`,
          );
        }
        actions[name] = {
          description: authored.description,
          input: authored.input,
          ...(authored.output ? { output: authored.output } : {}),
          effect: authored.effect,
          execute: runtime.execute,
          ...(authored.idempotent !== undefined ? { idempotent: authored.idempotent } : {}),
          ...(authored.reversible !== undefined ? { reversible: authored.reversible } : {}),
          ...(authored.confirmation !== undefined ? { confirmation: authored.confirmation } : {}),
          ...(authored.audit !== undefined ? { audit: authored.audit } : {}),
          ...(authored.meta ? { meta: authored.meta } : {}),
          ...(authored.timeoutMs !== undefined ? { timeoutMs: authored.timeoutMs } : {}),
          ...(authored.concurrency ? { concurrency: authored.concurrency } : {}),
          ...(runtime.when ? { when: runtime.when } : {}),
          ...(runtime.unavailableReason ? { unavailableReason: runtime.unavailableReason } : {}),
          ...(runtime.precondition ? { precondition: runtime.precondition } : {}),
          ...(runtime.policies ? { policies: runtime.policies } : {}),
        };
      }
      const bound: AgentComponentDefinition = {
        type: definition.type,
        description: definition.description,
        ...(bindings.instanceId !== undefined ? { instanceId: bindings.instanceId } : {}),
        ...(bindings.parent ? { parent: bindings.parent } : {}),
        ...(definition.meta ? { meta: definition.meta } : {}),
        ...(bindings.internal ? { internal: bindings.internal } : {}),
        ...(bindings.policies ? { policies: bindings.policies } : {}),
        ...(definition.origin ? { origin: definition.origin } : {}),
        ...(definition.priority !== undefined ? { priority: definition.priority } : {}),
        ...(bindings.enabled !== undefined ? { enabled: bindings.enabled } : {}),
        ...(Object.keys(observations).length > 0 ? { observations } : {}),
        ...(Object.keys(actions).length > 0 ? { actions } : {}),
        ...(bindings.procedures ? { procedures: bindings.procedures } : {}),
      };
      if (compiled) componentBindingProofs.set(bound, compiled);
      return bound;
    },
  };
  return contract;
}

export interface ExternalAgentToolContractDefinition<TIn extends JsonValue, TOut extends JsonValue> {
  id: string;
  description: string;
  input: AgentSchema<TIn>;
  output?: AgentSchema<TOut>;
  effect: AgentEffect;
  confirmation?: "never" | "optional" | "required";
  policies?: CapabilityPolicyAttachment[];
  tags?: string[];
}

export interface AgentProcedureContractDefinition<TIn extends JsonValue, TOut extends JsonValue> {
  id: `domain:${string}`;
  description: string;
  input: AgentSchema<TIn>;
  output?: AgentSchema<TOut>;
  effect: "server-query" | "server-mutation" | "external-side-effect" | "destructive";
  confirmation?: "never" | "optional" | "required";
  policies?: CapabilityPolicyAttachment[];
  tags?: string[];
}

export interface AgentProcedureContract<TIn extends JsonValue, TOut extends JsonValue> {
  readonly kind: "agent-procedure-contract";
  readonly definition: AgentProcedureContractDefinition<TIn, TOut>;
}

export function defineAgentProcedureContract<
  TIn extends JsonValue,
  TOut extends JsonValue = JsonValue,
>(
  definition: AgentProcedureContractDefinition<TIn, TOut>,
): AgentProcedureContract<TIn, TOut>;
export function defineAgentProcedureContract<
  TIn extends JsonValue,
  TOut extends JsonValue = JsonValue,
>(
  definition: AgentProcedureContractDefinition<TIn, TOut>,
  compiled?: CompiledCapabilityToken,
): AgentProcedureContract<TIn, TOut> {
  const contract: AgentProcedureContract<TIn, TOut> = {
    kind: "agent-procedure-contract",
    definition,
  };
  if (compiled) capabilityContractProofs.set(contract, compiled);
  return contract;
}

export interface CompiledExternalAgentTool<TIn extends JsonValue = JsonValue, TOut extends JsonValue = JsonValue> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute(input: TIn): TOut | Promise<TOut>;
}

export interface ExternalAgentToolContract<TIn extends JsonValue, TOut extends JsonValue> {
  readonly kind: "external-agent-tool-contract";
  readonly definition: ExternalAgentToolContractDefinition<TIn, TOut>;
  bind(binding: { execute(input: TIn): TOut | Promise<TOut> }): CompiledExternalAgentTool<TIn, TOut>;
}

export function defineExternalAgentToolContract<
  TIn extends JsonValue,
  TOut extends JsonValue = JsonValue,
>(
  definition: ExternalAgentToolContractDefinition<TIn, TOut>,
): ExternalAgentToolContract<TIn, TOut>;
export function defineExternalAgentToolContract<
  TIn extends JsonValue,
  TOut extends JsonValue = JsonValue,
>(
  definition: ExternalAgentToolContractDefinition<TIn, TOut>,
  compiled?: CompiledCapabilityToken,
): ExternalAgentToolContract<TIn, TOut> {
  const contract: ExternalAgentToolContract<TIn, TOut> = {
    kind: "external-agent-tool-contract",
    definition,
    bind(binding) {
      if (!compiled) {
        throw new AgentSurfaceDefinitionError(
          "INVALID_DEFINITION",
          `external contract "${definition.id}" has no compiler provenance`,
        );
      }
      const tool = {
        name: definition.id,
        description: definition.description,
        inputSchema: definition.input.jsonSchema,
        execute: binding.execute,
      } as CompiledExternalAgentTool<TIn, TOut>;
      externalToolProofs.set(tool, compiled);
      return tool;
    },
  };
  if (compiled) capabilityContractProofs.set(contract, compiled);
  return contract;
}

/** Preserve compiler proof while an adapter replaces handlers with latest-ref delegates. */
export function deriveAgentComponentBinding(
  source: AgentComponentDefinition,
  derived: AgentComponentDefinition,
): AgentComponentDefinition {
  const proof = componentBindingProofs.get(source);
  if (proof) componentBindingProofs.set(derived, proof);
  return derived;
}

/** Bind a compiled procedure contract to its contextual runtime definition. */
export function authorizeAgentProcedureBinding(
  contract: AgentProcedureContract<any, any>,
  definition: AgentComponentDefinition,
): AgentComponentDefinition {
  const token = capabilityContractProofs.get(contract);
  if (token) {
    componentBindingProofs.set(definition, {
      manifestHash: token.manifestHash,
      declarationId: token.declarationId,
      capabilities: { [token.capabilityId]: token },
    });
  }
  return definition;
}

function manifestIndex(manifest: CapabilityContractManifest): Map<string, CapabilityContractEntry> {
  if (
    manifest.formatVersion !== CAPABILITY_CONTRACT_FORMAT_VERSION ||
    manifest.completeness?.status !== "proven" ||
    typeof manifest.hash !== "string" ||
    manifest.hash.length === 0
  ) {
    throw new AgentSurfaceDefinitionError("INVALID_DEFINITION", "invalid compiled capability manifest");
  }
  const index = new Map<string, CapabilityContractEntry>();
  for (const entry of manifest.capabilities) {
    const { contractHash, targets: _targets, ...contract } = entry;
    if (sha256(canonicalContractJson(contract)) !== contractHash) {
      throw new AgentSurfaceDefinitionError(
        "INVALID_DEFINITION",
        `compiled contract hash is invalid for "${entry.capabilityId}"`,
      );
    }
    const key = `${entry.declarationId}\0${entry.capabilityId}`;
    if (index.has(key)) {
      throw new AgentSurfaceDefinitionError(
        "DUPLICATE_CAPABILITY",
        `duplicate compiled declaration "${entry.declarationId}" for "${entry.capabilityId}"`,
      );
    }
    index.set(key, entry);
  }
  const { hash, ...payload } = manifest;
  if (sha256(canonicalContractJson(payload)) !== hash) {
    throw new AgentSurfaceDefinitionError("INVALID_DEFINITION", "compiled manifest hash is invalid");
  }
  return index;
}

function canonicalContractValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("contract contains a non-finite number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalContractValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalContractValue(record[key])}`)
    .join(",")}}`;
}

function canonicalContractJson(value: unknown): string {
  return `${canonicalContractValue(value)}\n`;
}

export function createCapabilityAuthority(manifest: CapabilityContractManifest): CapabilityAuthority {
  const snapshot = deepFreeze(
    JSON.parse(JSON.stringify(manifest)) as CapabilityContractManifest,
  );
  const authority = Object.freeze({ manifest: snapshot }) as CapabilityAuthority;
  authorityStates.set(authority, { manifest: snapshot, index: manifestIndex(snapshot) });
  return authority;
}

function authorityState(authority: CapabilityAuthority): CapabilityAuthorityState {
  const state = authorityStates.get(authority);
  if (!state) {
    throw new AgentSurfaceDefinitionError(
      "INVALID_DEFINITION",
      "invalid capability authority: use compiler-generated authority",
    );
  }
  return state;
}

/** @internal Registry constructor guard. */
export function assertCapabilityAuthority(authority: CapabilityAuthority): void {
  authorityState(authority);
}

function assertToken(
  token: CompiledCapabilityToken,
  manifest: CapabilityContractManifest,
  index: ReadonlyMap<string, CapabilityContractEntry>,
): void {
  if (token.manifestHash !== manifest.hash) {
    throw new AgentSurfaceDefinitionError(
      "INVALID_DEFINITION",
      `stale compiler token for "${token.capabilityId}": manifest hash mismatch`,
    );
  }
  const declared = index.get(`${token.declarationId}\0${token.capabilityId}`);
  if (!declared) {
    throw new AgentSurfaceDefinitionError(
      "INVALID_DEFINITION",
      `unknown compiled declaration "${token.declarationId}" for "${token.capabilityId}"`,
    );
  }
  if (declared.contractHash !== token.contractHash) {
    throw new AgentSurfaceDefinitionError(
      "INVALID_DEFINITION",
      `compiled contract hash mismatch for "${token.capabilityId}"`,
    );
  }
}

interface RuntimeCapabilityShape {
  capabilityId: string;
  kind: "observation" | "action" | "procedure";
  description: string;
  effect: AgentEffect;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  confirmation?: "never" | "optional" | "required";
  policies: AgentPolicy[];
}

const CONFIRMATION_RANK = { never: 0, optional: 1, required: 2 } as const;

function effectiveProcedureConfirmation(
  binding: AgentProcedureBinding<any, any>,
): "never" | "optional" | "required" {
  if (binding.ref.requiresApproval || binding.config.confirmation === "required") return "required";
  return binding.config.confirmation ?? "never";
}

function runtimeCapabilities(definition: AgentComponentDefinition): RuntimeCapabilityShape[] {
  const sharedPolicies = definition.policies ?? [];
  return [
    ...Object.entries(definition.observations ?? {}).map(([name, observation]) => ({
      capabilityId: `view:${definition.type}.${name}`,
      kind: "observation" as const,
      description: observation.description,
      effect: "read" as const,
      outputSchema: observation.output.jsonSchema,
      policies: [...sharedPolicies, ...(observation.policies ?? [])],
    })),
    ...Object.entries(definition.actions ?? {}).map(([name, action]) => ({
      capabilityId: `view:${definition.type}.${name}`,
      kind: "action" as const,
      description: action.description,
      effect: action.effect,
      inputSchema: action.input.jsonSchema,
      ...(action.output ? { outputSchema: action.output.jsonSchema } : {}),
      confirmation: action.confirmation ?? "never",
      policies: [...sharedPolicies, ...(action.policies ?? [])],
    })),
    ...(definition.procedures ?? []).map((binding) => ({
      capabilityId: binding.ref.id,
      kind: "procedure" as const,
      description: binding.ref.description,
      effect: binding.ref.effect,
      inputSchema: binding.ref.inputSchema,
      ...(binding.ref.outputSchema ? { outputSchema: binding.ref.outputSchema } : {}),
      confirmation: effectiveProcedureConfirmation(binding),
      policies: [...sharedPolicies, ...(binding.config.policies ?? [])],
    })),
  ];
}

function assertPolicyCoverage(
  declared: readonly CapabilityPolicyAttachment[] | undefined,
  runtime: readonly AgentPolicy[],
  capabilityId: string,
): void {
  for (const attachment of declared ?? []) {
    const policy = runtime.find((candidate) => candidate.name === attachment.name);
    const phaseImplemented =
      !attachment.phase ||
      (attachment.phase === "discovery" && typeof policy?.onDiscovery === "function") ||
      (attachment.phase === "authorize" && typeof policy?.onAuthorize === "function") ||
      (attachment.phase === "invoke" && typeof policy?.onInvoke === "function");
    if (!policy || !phaseImplemented) {
      throw new AgentSurfaceDefinitionError(
        "INVALID_DEFINITION",
        `capability "${capabilityId}" omits required policy "${attachment.name}"${attachment.phase ? ` at ${attachment.phase}` : ""}`,
      );
    }
  }
}

function assertRuntimeMatchesContract(
  runtime: RuntimeCapabilityShape,
  declared: CapabilityContractEntry,
): void {
  const mismatch = (field: string): never => {
    throw new AgentSurfaceDefinitionError(
      "INVALID_DEFINITION",
      `runtime ${field} mismatch for "${runtime.capabilityId}"`,
    );
  };
  if (declared.kind !== runtime.kind) mismatch("kind");
  if (declared.description !== runtime.description) mismatch("description");
  if (declared.effect !== runtime.effect) mismatch("effect");
  if (!jsonDeepEqual(declared.inputSchema as JsonValue | undefined, runtime.inputSchema as JsonValue | undefined)) {
    mismatch("input schema");
  }
  if (!jsonDeepEqual(declared.outputSchema as JsonValue | undefined, runtime.outputSchema as JsonValue | undefined)) {
    mismatch("output schema");
  }
  const declaredConfirmation = declared.confirmation ?? "never";
  const runtimeConfirmation = runtime.confirmation ?? "never";
  if (CONFIRMATION_RANK[runtimeConfirmation] < CONFIRMATION_RANK[declaredConfirmation]) {
    mismatch("confirmation");
  }
  assertPolicyCoverage(declared.policies, runtime.policies, runtime.capabilityId);
}

/** Mandatory runtime authority check used by every registry registration. */
export function assertDefinitionAuthorized(
  definition: AgentComponentDefinition,
  authority: CapabilityAuthority,
): void {
  const state = authorityState(authority);
  const provenance = componentBindingProofs.get(definition);
  if (!provenance) {
    throw new AgentSurfaceDefinitionError(
      "INVALID_DEFINITION",
      `raw registration "${definition.type}" rejected: bind a compiler-generated contract`,
    );
  }
  if (provenance.manifestHash !== state.manifest.hash) {
    throw new AgentSurfaceDefinitionError(
      "INVALID_DEFINITION",
      `stale contract "${provenance.declarationId}": manifest hash mismatch`,
    );
  }
  const capabilities = runtimeCapabilities(definition);
  const expected = capabilities.map((capability) => capability.capabilityId);
  for (const capability of capabilities) {
    const capabilityId = capability.capabilityId;
    const token = provenance.capabilities[capabilityId];
    if (!token) {
      throw new AgentSurfaceDefinitionError(
        "INVALID_DEFINITION",
        `capability "${capabilityId}" is absent from compiled contract "${provenance.declarationId}"`,
      );
    }
    assertToken(token, state.manifest, state.index);
    const declared = state.index.get(`${token.declarationId}\0${token.capabilityId}`)!;
    assertRuntimeMatchesContract(capability, declared);
  }
  for (const capabilityId of Object.keys(provenance.capabilities)) {
    if (!expected.includes(capabilityId)) {
      throw new AgentSurfaceDefinitionError(
        "INVALID_DEFINITION",
        `binding for "${provenance.declarationId}" omits compiled capability "${capabilityId}"`,
      );
    }
  }
}

export interface AgentExposureGateway {
  expose<T extends CompiledExternalAgentTool>(tools: readonly T[]): T[];
}

/** Final provider/MCP boundary: arbitrary tool objects cannot pass. */
export function createAgentExposureGateway(authority: CapabilityAuthority): AgentExposureGateway {
  const state = authorityState(authority);
  return {
    expose<T extends CompiledExternalAgentTool>(tools: readonly T[]): T[] {
      return tools.map((tool) => {
        const token = externalToolProofs.get(tool);
        if (!token) {
          throw new AgentSurfaceDefinitionError(
            "INVALID_DEFINITION",
            `raw provider tool "${tool.name}" rejected by compiled exposure gateway`,
          );
        }
        assertToken(token, state.manifest, state.index);
        const declared = state.index.get(`${token.declarationId}\0${token.capabilityId}`)!;
        if (declared.kind !== "external") {
          throw new AgentSurfaceDefinitionError(
            "INVALID_DEFINITION",
            `runtime kind mismatch for "${tool.name}"`,
          );
        }
        if (declared.capabilityId !== tool.name || declared.description !== tool.description) {
          throw new AgentSurfaceDefinitionError(
            "INVALID_DEFINITION",
            `runtime external tool mismatch for "${tool.name}"`,
          );
        }
        if (!jsonDeepEqual(declared.inputSchema as JsonValue, tool.inputSchema as JsonValue)) {
          throw new AgentSurfaceDefinitionError(
            "INVALID_DEFINITION",
            `runtime input schema mismatch for "${tool.name}"`,
          );
        }
        return tool;
      });
    },
  };
}
