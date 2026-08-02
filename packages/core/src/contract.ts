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

/** Contract format emitted by @agent-surface/compiler. */
export const CAPABILITY_CONTRACT_FORMAT_VERSION = 3 as const;

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

export interface ExternalCapabilityContractDigest {
  package?: string;
  source: string;
  digest: string;
}

export interface CapabilityContractManifest {
  formatVersion: typeof CAPABILITY_CONTRACT_FORMAT_VERSION;
  compilerVersion: string;
  targets: string[];
  capabilities: CapabilityContractEntry[];
  externalContracts: ExternalCapabilityContractDigest[];
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

/** Shared across duplicate copies of core in a bundle. Not enumerable/serializable. */
export const COMPILED_CAPABILITY_PROVENANCE = Symbol.for(
  "@agent-surface/core.compiled-capability-provenance",
);

type ProvenanceCarrier = {
  [COMPILED_CAPABILITY_PROVENANCE]?: CompiledComponentProvenance | CompiledCapabilityToken;
};

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
      const bound: AgentComponentDefinition & ProvenanceCarrier = {
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
      if (compiled) {
        Object.defineProperty(bound, COMPILED_CAPABILITY_PROVENANCE, {
          value: compiled,
          enumerable: false,
        });
      }
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

export interface AgentProcedureContract<TIn extends JsonValue, TOut extends JsonValue>
  extends ProvenanceCarrier {
  readonly kind: "agent-procedure-contract";
  readonly definition: AgentProcedureContractDefinition<TIn, TOut>;
}

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
  if (compiled) {
    Object.defineProperty(contract, COMPILED_CAPABILITY_PROVENANCE, {
      value: compiled,
      enumerable: false,
    });
  }
  return contract;
}

export interface CompiledExternalAgentTool<TIn extends JsonValue = JsonValue, TOut extends JsonValue = JsonValue> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute(input: TIn): TOut | Promise<TOut>;
  [COMPILED_CAPABILITY_PROVENANCE]: CompiledCapabilityToken;
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
      Object.defineProperty(tool, COMPILED_CAPABILITY_PROVENANCE, {
        value: compiled,
        enumerable: false,
      });
      return tool;
    },
  };
  if (compiled) {
    Object.defineProperty(contract, COMPILED_CAPABILITY_PROVENANCE, {
      value: compiled,
      enumerable: false,
    });
  }
  return contract;
}

export function compiledCapabilityToken(
  contract: AgentProcedureContract<any, any> | ExternalAgentToolContract<any, any>,
): CompiledCapabilityToken {
  const token = (contract as ProvenanceCarrier)[COMPILED_CAPABILITY_PROVENANCE];
  if (!token || "capabilities" in token) {
    throw new AgentSurfaceDefinitionError(
      "INVALID_DEFINITION",
      `contract "${contract.definition.id}" has no compiler provenance`,
    );
  }
  return token;
}

export function tryCompiledCapabilityToken(
  contract: AgentProcedureContract<any, any> | ExternalAgentToolContract<any, any>,
): CompiledCapabilityToken | undefined {
  const token = (contract as ProvenanceCarrier)[COMPILED_CAPABILITY_PROVENANCE];
  return token && !("capabilities" in token) ? token : undefined;
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
    const key = `${entry.declarationId}\0${entry.capabilityId}`;
    if (index.has(key)) {
      throw new AgentSurfaceDefinitionError(
        "DUPLICATE_CAPABILITY",
        `duplicate compiled declaration "${entry.declarationId}" for "${entry.capabilityId}"`,
      );
    }
    index.set(key, entry);
  }
  return index;
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

/** Runtime exposure ceiling used by the registry. */
export function assertDefinitionInManifest(
  definition: AgentComponentDefinition,
  manifest: CapabilityContractManifest,
): void {
  const provenance = (definition as AgentComponentDefinition & ProvenanceCarrier)[
    COMPILED_CAPABILITY_PROVENANCE
  ];
  if (!provenance || !("capabilities" in provenance)) {
    throw new AgentSurfaceDefinitionError(
      "INVALID_DEFINITION",
      `raw registration "${definition.type}" rejected: bind a compiler-generated contract`,
    );
  }
  if (provenance.manifestHash !== manifest.hash) {
    throw new AgentSurfaceDefinitionError(
      "INVALID_DEFINITION",
      `stale contract "${provenance.declarationId}": manifest hash mismatch`,
    );
  }
  const index = manifestIndex(manifest);
  const expected = [
    ...Object.keys(definition.observations ?? {}).map((name) => `view:${definition.type}.${name}`),
    ...Object.keys(definition.actions ?? {}).map((name) => `view:${definition.type}.${name}`),
    ...(definition.procedures ?? []).map((binding) => binding.ref.id),
  ];
  for (const capabilityId of expected) {
    const token = provenance.capabilities[capabilityId];
    if (!token) {
      throw new AgentSurfaceDefinitionError(
        "INVALID_DEFINITION",
        `capability "${capabilityId}" is absent from compiled contract "${provenance.declarationId}"`,
      );
    }
    assertToken(token, manifest, index);
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
export function createAgentExposureGateway(manifest: CapabilityContractManifest): AgentExposureGateway {
  const index = manifestIndex(manifest);
  return {
    expose<T extends CompiledExternalAgentTool>(tools: readonly T[]): T[] {
      return tools.map((tool) => {
        const token = tool[COMPILED_CAPABILITY_PROVENANCE];
        if (!token) {
          throw new AgentSurfaceDefinitionError(
            "INVALID_DEFINITION",
            `raw provider tool "${tool.name}" rejected by compiled exposure gateway`,
          );
        }
        assertToken(token, manifest, index);
        return tool;
      });
    },
  };
}
