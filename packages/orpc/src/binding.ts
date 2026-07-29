import type {
  AgentPolicy,
  AgentProcedureBinding,
  JsonSchema,
  JsonValue,
} from "@agent-surface/core";
import type { AgentProcedureRef } from "./bridge.js";

export interface AgentProcedureBindingConfig<
  TIn extends object,
  TBound extends Partial<TIn>,
> {
  /** Contextual availability; same semantics as capability `when`. */
  when?: () => boolean;
  unavailableReason?: string | (() => string);
  /**
   * UI-derived inputs. Evaluated at EXECUTION time (never cached from
   * discovery). Throwing or returning schema-invalid values fails the
   * invocation with PRECONDITION_FAILED (details.reason: "binding-failed").
   */
  bind?: () => TBound;
  /**
   * Bound fields the agent MAY override. Default: none — bound fields are
   * locked (D8). Use sparingly.
   */
  overridableFields?: ReadonlyArray<keyof TBound & string>;
  /** Escalate (never lower) the manifest's confirmation requirement. */
  confirmation?: "optional" | "required";
  /** Extra frontend policies (client-side, advisory). */
  policies?: AgentPolicy[];
  /** Contextual description appended to the manifest description. */
  describe?: () => string;
  meta?: Record<string, JsonValue>;
}

/**
 * D7 rule 1 — agent-facing schema surgery: locked bound keys are removed from
 * `properties` and `required`; overridable bound keys stay, annotated as
 * defaulting to the current UI value. All-bound ⇒ empty closed object schema.
 */
export function reduceInputSchema(
  full: JsonSchema,
  boundKeys: ReadonlyArray<string>,
  overridable: ReadonlySet<string>,
): JsonSchema {
  const clone = JSON.parse(JSON.stringify(full)) as JsonSchema;
  const properties = (clone.properties ?? {}) as Record<string, unknown>;
  const lockedKeys = boundKeys.filter((k) => !overridable.has(k));

  for (const key of lockedKeys) {
    delete properties[key];
  }
  for (const key of boundKeys) {
    if (!overridable.has(key)) continue;
    const prop = properties[key];
    if (typeof prop === "object" && prop !== null) {
      const record = prop as Record<string, unknown>;
      const note = "Defaults to the current UI value at execution time when omitted.";
      record.description =
        typeof record.description === "string" && record.description.length > 0
          ? `${record.description} ${note}`
          : note;
    }
  }
  if (Array.isArray(clone.required)) {
    // Locked keys are supplied by the binding; overridable keys become
    // optional for the agent (the bound value applies when omitted).
    const removed = new Set(boundKeys);
    clone.required = (clone.required as string[]).filter((k) => !removed.has(k));
    if ((clone.required as string[]).length === 0) delete clone.required;
  }
  if (Object.keys(properties).length === 0) {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  clone.properties = properties;
  return clone;
}

/**
 * Creates a procedure binding for AgentComponentDefinition.procedures or the
 * React hook. The binding's identity IS the procedure's identity — there is
 * deliberately no place to put an execute handler here (docs/05).
 */
export function bindAgentProcedure<
  TIn extends object,
  TOut,
  TBound extends Partial<TIn> = Partial<TIn>,
>(
  ref: AgentProcedureRef<TIn, TOut>,
  config?: AgentProcedureBindingConfig<TIn, TBound>,
): AgentProcedureBinding<TIn, TOut> {
  // Bound-key capture at binding creation: bind() must be key-stable; a
  // throwing bind() here degrades to "no bound keys" with a warning.
  let boundKeys: string[] = [];
  if (config?.bind) {
    try {
      boundKeys = Object.keys(config.bind() ?? {});
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[agent-surface] bind() threw while capturing bound keys for ${ref.id}; treating as unbound`,
        err,
      );
    }
  }
  const overridable = new Set<string>([...(config?.overridableFields ?? [])]);
  const lockedKeys = boundKeys.filter((k) => !overridable.has(k));

  return {
    kind: "procedure-binding",
    ref: {
      id: ref.id,
      path: ref.path,
      description: ref.description,
      inputSchema: ref.inputSchema,
      ...(ref.outputSchema ? { outputSchema: ref.outputSchema } : {}),
      effect: ref.effect,
      ...(ref.requiresApproval !== undefined ? { requiresApproval: ref.requiresApproval } : {}),
    },
    config: {
      ...(config?.when ? { when: config.when } : {}),
      ...(config?.unavailableReason !== undefined
        ? { unavailableReason: config.unavailableReason }
        : {}),
      ...(config?.bind ? { bind: config.bind as () => Record<string, JsonValue> } : {}),
      ...(config?.overridableFields
        ? { overridableFields: config.overridableFields as ReadonlyArray<string> }
        : {}),
      ...(config?.confirmation ? { confirmation: config.confirmation } : {}),
      ...(config?.policies ? { policies: config.policies } : {}),
      ...(config?.describe ? { describe: config.describe } : {}),
      ...(config?.meta ? { meta: config.meta } : {}),
    },
    boundKeys,
    lockedKeys,
    reducedInputSchema: reduceInputSchema(ref.inputSchema, boundKeys, overridable),
  };
}
