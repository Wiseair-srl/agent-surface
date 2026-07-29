import type { AgentConsumer, JsonValue } from "./types.js";
import type {
  AgentInvocation,
  AgentInvocationResult,
  InvokeOptions,
} from "./invocation-types.js";
import type {
  ActionRuntime,
  CapabilityRuntime,
  InFlightEntry,
  InternalRegistration,
  ObservationRuntime,
  ProcedureRuntime,
  RegistryInternals,
} from "./internal.js";
import {
  DevDefectError,
  buildPolicyContext,
  computeAvailability,
  maxConfirmation,
  policiesFor,
} from "./internal.js";
import type { AgentCapabilityErrorPayload } from "./errors.js";
import { AgentSurfaceError, isAgentSurfaceError } from "./errors.js";
import { parseCapabilityId } from "./ids.js";
import { AgentSchemaError, fromJsonSchema } from "./schema.js";
import {
  CONFIRMATION_ESCALATION,
  composeInvokeChain,
  evaluateDiscovery,
  type AgentPolicyWithEscalation,
  type ConfirmationEscalation,
} from "./policy.js";
import type { AgentActionContext, AgentReadContext } from "./definition.js";
import { isJsonValue, randomBase62, truncate } from "./utils.js";

const DEFAULT_CONSUMER: AgentConsumer = { id: "anonymous", kind: "embedded" };

/* ─────────────────────── error payload constructors ─────────────────────── */

function notFound(): AgentCapabilityErrorPayload {
  return {
    code: "CAPABILITY_NOT_FOUND",
    message:
      "This capability does not exist in the current surface. Refresh the surface catalog before the next step.",
    retry: "after-refresh",
  };
}

function notAvailable(reason: string | undefined): AgentCapabilityErrorPayload {
  return {
    code: "CAPABILITY_NOT_AVAILABLE",
    message: `This capability exists but is currently unavailable${reason ? `: ${reason}` : ""}. Perform the enabling step first, then refresh.`,
    retry: "after-refresh",
    ...(reason !== undefined ? { details: { reason } } : {}),
  };
}

function unmounted(phase: "resolve" | "mid-flight"): AgentCapabilityErrorPayload {
  return {
    code: "COMPONENT_UNMOUNTED",
    message:
      phase === "mid-flight"
        ? "The owning view unmounted while this capability was executing. Verify state before repeating a non-idempotent action."
        : "The owning view is no longer mounted. Refresh the surface catalog.",
    retry: "after-refresh",
    details: { phase },
  };
}

function stale(
  reason: "registration-replaced" | "surface-reloaded" | "surface-version-mismatch",
  liveRegistrationId?: string,
): AgentCapabilityErrorPayload {
  return {
    code: "STALE_CAPABILITY",
    message:
      "The invocation references a superseded surface snapshot. Refresh the catalog and re-resolve the target.",
    retry: "after-refresh",
    details: { reason, ...(liveRegistrationId ? { liveRegistrationId } : {}) },
  };
}

function executionFailed(
  reason: "handler-error" | "output-invalid" | "output-too-large" | "transport",
  opts?: { transient?: boolean },
): AgentCapabilityErrorPayload {
  const messages: Record<string, string> = {
    "handler-error": "The capability failed to execute.",
    "output-invalid": "The capability produced an invalid output.",
    "output-too-large": "The capability produced an output exceeding the size limit.",
    transport: "The server call failed.",
  };
  return {
    code: "EXECUTION_FAILED",
    message: messages[reason] ?? "The capability failed to execute.",
    retry: opts?.transient ? "after-delay" : "no",
    details: {
      reason,
      ...(opts?.transient ? { transient: true, retryAfterMs: 1000 } : {}),
    },
  };
}

/* ─────────────────────────── entry + dedupe (D14) ─────────────────────────── */

export function performInvoke(
  internals: RegistryInternals,
  request: AgentInvocation,
  options?: InvokeOptions,
): Promise<AgentInvocationResult> {
  if (internals.disposed) {
    throw new Error("invoke() called on a disposed registry");
  }
  const invocationId = request.invocationId ?? `inv_${randomBase62(12)}`;

  pruneDedupe(internals);
  const existing = internals.dedupe.get(invocationId);
  if (existing) {
    if (existing.kind === "inflight") return existing.promise; // join, don't re-execute
    if (existing.expiresAt > internals.now()) return Promise.resolve(existing.result);
    internals.dedupe.delete(invocationId);
  }

  const promise = runPipeline(internals, request, invocationId, options);
  internals.dedupe.set(invocationId, { kind: "inflight", promise });
  promise.then(
    (result) => {
      // Terminal = ok and every error except CONFIRMATION_REQUIRED / RATE_LIMITED.
      const terminal =
        result.status === "ok" ||
        (result.error.code !== "CONFIRMATION_REQUIRED" && result.error.code !== "RATE_LIMITED");
      if (terminal) {
        internals.dedupe.set(invocationId, {
          kind: "terminal",
          result,
          expiresAt: internals.now() + internals.limits.dedupeCacheTtlMs,
        });
        pruneDedupe(internals);
      } else {
        internals.dedupe.delete(invocationId);
      }
    },
    () => {
      internals.dedupe.delete(invocationId);
    },
  );
  return promise;
}

function pruneDedupe(internals: RegistryInternals): void {
  const now = internals.now();
  for (const [id, entry] of internals.dedupe) {
    if (entry.kind === "terminal" && entry.expiresAt <= now) internals.dedupe.delete(id);
  }
  while (internals.dedupe.size > internals.limits.dedupeCacheSize) {
    const oldest = internals.dedupe.keys().next().value;
    if (oldest === undefined) break;
    const entry = internals.dedupe.get(oldest);
    if (entry?.kind === "inflight") break; // never evict in-flight joins
    internals.dedupe.delete(oldest);
  }
}

/* ───────────────────────────── the 9 phases ───────────────────────────── */

interface ResolvedTarget {
  reg: InternalRegistration;
  cap: CapabilityRuntime;
}

async function runPipeline(
  internals: RegistryInternals,
  request: AgentInvocation,
  invocationId: string,
  options?: InvokeOptions,
): Promise<AgentInvocationResult> {
  const consumer = options?.consumer ?? DEFAULT_CONSUMER;
  const startVersion = internals.version;
  const startedAt = internals.now();
  internals.emit({
    type: "invocation-started",
    invocationId,
    capabilityId: request.capabilityId,
    consumerId: consumer.id,
  });

  let resolvedAuditLevel: "none" | "metadata" | "full" = "metadata";
  let resolvedRegistrationId: string | undefined;
  let inputForAudit: JsonValue | undefined;
  let outputForAudit: JsonValue | undefined;

  const finalize = (
    body:
      | { status: "ok"; output?: JsonValue }
      | { status: "error"; error: AgentCapabilityErrorPayload },
  ): AgentInvocationResult => {
    const surfaceVersion = String(internals.version);
    const surfaceChanged = internals.version !== startVersion ? true : undefined;
    const result: AgentInvocationResult =
      body.status === "ok"
        ? {
            status: "ok",
            invocationId,
            capabilityId: request.capabilityId,
            ...(body.output !== undefined ? { output: body.output } : {}),
            surfaceVersion,
            ...(surfaceChanged ? { surfaceChanged } : {}),
          }
        : {
            status: "error",
            invocationId,
            capabilityId: request.capabilityId,
            error: body.error,
            surfaceVersion,
            ...(surfaceChanged ? { surfaceChanged } : {}),
          };
    const durationMs = internals.now() - startedAt;
    internals.emit({
      type: "invocation-settled",
      invocationId,
      capabilityId: request.capabilityId,
      status: result.status,
      ...(result.status === "error" ? { code: result.error.code } : {}),
      durationMs,
    });
    if (resolvedAuditLevel !== "none") {
      internals.recordAudit({
        type: "invocation-settled",
        capabilityId: request.capabilityId,
        registrationId: resolvedRegistrationId,
        invocationId,
        consumerId: consumer.id,
        status: result.status,
        ...(result.status === "error" ? { code: result.error.code } : {}),
        durationMs,
        ...(resolvedAuditLevel === "full"
          ? {
              payload: {
                ...(inputForAudit !== undefined ? { input: inputForAudit } : {}),
                ...(outputForAudit !== undefined ? { output: outputForAudit } : {}),
              },
            }
          : {}),
      });
    }
    return result;
  };

  try {
    /* phase 2 — resolve */
    const resolved = resolveTarget(internals, request);
    if ("error" in resolved) return finalize({ status: "error", error: resolved.error });
    const { reg, cap } = resolved;
    resolvedRegistrationId = reg.id;
    resolvedAuditLevel = cap.auditLevel;

    // surfaceVersion is enforced only for dangerous effects (docs/03 §versioning).
    if (
      request.surfaceVersion !== undefined &&
      request.surfaceVersion !== String(internals.version) &&
      cap.kind === "procedure" &&
      (cap.effect === "destructive" || cap.effect === "external-side-effect")
    ) {
      return finalize({ status: "error", error: stale("surface-version-mismatch") });
    }

    if (resolvedAuditLevel !== "none") {
      internals.recordAudit({
        type: "invocation-started",
        capabilityId: cap.capabilityId,
        registrationId: reg.id,
        invocationId,
        consumerId: consumer.id,
      });
    }

    /* phase 3 — availability (re-evaluated, never trusted from discovery) */
    const availability = computeAvailability(internals, reg, cap);
    if (!availability.available) {
      return finalize({ status: "error", error: notAvailable(availability.reason) });
    }

    /* phase 4 — policy chain. The onDiscovery re-run in the preamble covers
       discovery-only policies (hide ⇒ NOT_FOUND, disable ⇒ NOT_AVAILABLE);
       policies that define onInvoke are the authoritative client-side gate
       and produce their own typed errors (NOT_AUTHENTICATED, …). */
    const host = internals.host();
    const chain = policiesFor(internals, reg, cap);
    const policyCtx = buildPolicyContext(internals, reg, cap, consumer, host);
    const discovery = evaluateDiscovery(
      chain.filter((p) => !p.onInvoke),
      policyCtx,
    );
    if (discovery.decision === "hide") {
      // Indistinguishable from nonexistence for this consumer (requirement 12).
      return finalize({ status: "error", error: notFound() });
    }
    if (discovery.decision === "disable") {
      return finalize({ status: "error", error: notAvailable(discovery.reason) });
    }
    const escalations = chain
      .map((p) => (p as AgentPolicyWithEscalation)[CONFIRMATION_ESCALATION])
      .filter((e): e is ConfirmationEscalation => e !== undefined);

    const core = (): Promise<AgentInvocationResult> =>
      executeCore(internals, {
        request,
        invocationId,
        consumer,
        host,
        reg,
        cap,
        escalations,
        options,
        finalize,
        setAuditPayload: (input, output) => {
          if (input !== undefined) inputForAudit = input;
          if (output !== undefined) outputForAudit = output;
        },
      });

    const invokeCtx = { ...policyCtx, invocationId, input: request.input };
    try {
      return await composeInvokeChain(chain, invokeCtx, core);
    } catch (err) {
      if (isAgentSurfaceError(err)) {
        return finalize({ status: "error", error: err.payload });
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof DevDefectError) throw err; // dev probes throw out of invoke()
    if (isAgentSurfaceError(err)) {
      return finalize({ status: "error", error: err.payload });
    }
    internals.devError("[agent-surface] invocation pipeline failure", err);
    return finalize({ status: "error", error: executionFailed("handler-error") });
  }
}

/* ───────────────────────────── resolution ───────────────────────────── */

function resolveTarget(
  internals: RegistryInternals,
  request: AgentInvocation,
): ResolvedTarget | { error: AgentCapabilityErrorPayload } {
  const parsed = parseCapabilityId(request.capabilityId);
  if (!parsed) return { error: notFound() };

  interface Candidate {
    reg: InternalRegistration;
    cap: CapabilityRuntime;
  }
  let candidates: Candidate[] = [];

  if (parsed.plane === "view") {
    for (const reg of internals.registrations.values()) {
      if (reg.status !== "active" || reg.type !== parsed.componentType) continue;
      const cap: ObservationRuntime | ActionRuntime | undefined =
        reg.observations.get(parsed.name) ?? reg.actions.get(parsed.name);
      if (cap) candidates.push({ reg, cap });
    }
  } else {
    for (const reg of internals.registrations.values()) {
      if (reg.status !== "active") continue;
      for (const proc of reg.procedures) {
        if (proc.path === parsed.path) candidates.push({ reg, cap: proc });
      }
    }
  }

  if (request.instanceId !== undefined) {
    candidates = candidates.filter((c) => c.reg.instanceId === request.instanceId);
  }
  candidates.sort((a, b) =>
    a.reg.instanceId < b.reg.instanceId ? -1 : a.reg.instanceId > b.reg.instanceId ? 1 : 0,
  );

  if (request.registrationId !== undefined) {
    const live = candidates.find((c) => c.reg.id === request.registrationId);
    if (live) return live;
    if (candidates.length > 0) {
      const reason = internals.tombstones.has(request.registrationId)
        ? ("registration-replaced" as const)
        : ("surface-reloaded" as const);
      return { error: stale(reason, candidates[0]?.reg.id) };
    }
    if (internals.tombstones.has(request.registrationId)) {
      return { error: unmounted("resolve") };
    }
    return { error: notFound() };
  }

  if (candidates.length === 0) {
    for (const tomb of internals.tombstones.values()) {
      if (tomb.expiresAt <= internals.now()) continue;
      if (tomb.capabilityIds.has(request.capabilityId)) {
        return { error: unmounted("resolve") };
      }
    }
    return { error: notFound() };
  }
  if (candidates.length > 1) {
    const instances: JsonValue = candidates.map((c) => {
      const entry: Record<string, JsonValue> = {
        instanceId: c.reg.instanceId,
        registrationId: c.reg.id,
      };
      if (c.cap.kind === "procedure") {
        if (c.cap.contextLink) entry.context = { ...c.cap.contextLink };
      } else {
        entry.description = c.reg.description;
      }
      return entry;
    });
    return {
      error: {
        code: "AMBIGUOUS_INSTANCE",
        message:
          "More than one live instance matches this capability. Re-issue the call with an explicit instanceId or registrationId.",
        retry: "with-changes",
        details: { instances },
      },
    };
  }
  return candidates[0] as Candidate;
}

/* ───────────────────────── phases 5–9 per kind ───────────────────────── */

interface CoreArgs {
  request: AgentInvocation;
  invocationId: string;
  consumer: AgentConsumer;
  host: Record<string, unknown>;
  reg: InternalRegistration;
  cap: CapabilityRuntime;
  escalations: ConfirmationEscalation[];
  options: InvokeOptions | undefined;
  finalize: (
    body:
      | { status: "ok"; output?: JsonValue }
      | { status: "error"; error: AgentCapabilityErrorPayload },
  ) => AgentInvocationResult;
  setAuditPayload: (input?: JsonValue, output?: JsonValue) => void;
}

async function executeCore(
  internals: RegistryInternals,
  args: CoreArgs,
): Promise<AgentInvocationResult> {
  const { cap } = args;
  if (cap.kind === "observation") return executeObservation(internals, args, cap);
  if (cap.kind === "action") return executeAction(internals, args, cap);
  return executeProcedure(internals, args, cap);
}

async function executeObservation(
  internals: RegistryInternals,
  args: CoreArgs,
  cap: ObservationRuntime,
): Promise<AgentInvocationResult> {
  // Observations skip input parsing, confirmation, and the action queue.
  const { reg, invocationId, consumer, host, options, finalize } = args;
  const readCtx: AgentReadContext = {
    capabilityId: cap.capabilityId,
    registrationId: reg.id,
    consumer,
    host,
  };
  const timeoutMs = options?.timeoutMs ?? cap.timeoutMs ?? internals.limits.observationTimeoutMs;
  const outcome = await executeWithGuards(internals, reg, {
    invocationId,
    capabilityId: cap.capabilityId,
    timeoutMs,
    externalSignal: options?.signal,
    idempotent: true,
    run: () => {
      const live = reg.definition.observations?.[cap.name];
      if (!live) throw new Error("observation handler missing");
      return live.read(readCtx);
    },
  });
  if (!outcome.ok) return finalize({ status: "error", error: outcome.payload });
  const output = settleOutput(internals, outcome.value, cap.outputSchema);
  if ("error" in output) return finalize({ status: "error", error: output.error });
  args.setAuditPayload(undefined, undefined);
  return finalize({ status: "ok", output: output.value });
}

async function executeAction(
  internals: RegistryInternals,
  args: CoreArgs,
  cap: ActionRuntime,
): Promise<AgentInvocationResult> {
  const { request, reg, invocationId, consumer, host, options, finalize, escalations } = args;

  /* phase 5 — input */
  let parsedInput: JsonValue;
  try {
    parsedInput = cap.inputSchema.parse(request.input) as JsonValue;
  } catch (err) {
    return finalize({ status: "error", error: invalidInput(err) });
  }
  args.setAuditPayload(parsedInput, undefined);

  const readCtx: AgentReadContext = {
    capabilityId: cap.capabilityId,
    registrationId: reg.id,
    consumer,
    host,
  };

  /* confirmation gate (uniform protocol, OQ-12) */
  const confirmation = gateConfirmation(internals, {
    ...args,
    effectiveInput: parsedInput,
    declared: cap.confirmation,
    description: cap.description,
    effect: cap.effect,
  });
  if ("error" in confirmation) return finalize({ status: "error", error: confirmation.error });

  /* phase 6 — precondition */
  const livePrecondition = reg.definition.actions?.[cap.name]?.precondition;
  if (livePrecondition) {
    try {
      const failure = livePrecondition(parsedInput, readCtx);
      if (failure && typeof failure.message === "string") {
        return finalize({ status: "error", error: preconditionFailed(failure.message, failure.details) });
      }
    } catch (err) {
      if (isAgentSurfaceError(err)) return finalize({ status: "error", error: err.payload });
      if (!(err instanceof Error) && typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string") {
        const failure = err as { message: string; details?: Record<string, JsonValue> };
        return finalize({ status: "error", error: preconditionFailed(failure.message, failure.details) });
      }
      internals.devError(`[agent-surface] precondition threw for ${cap.capabilityId}`, err);
      return finalize({ status: "error", error: executionFailed("handler-error") });
    }
  }

  /* phase 7 — concurrency: actions serialize per component instance (D13) */
  const slot = await acquireActionSlot(internals, reg);
  if (slot === "overflow") {
    return finalize({
      status: "error",
      error: {
        code: "RATE_LIMITED",
        message: "The action queue for this component is full. Retry shortly.",
        retry: "after-delay",
        details: { reason: "queue-full", retryAfterMs: 250 },
      },
    });
  }

  try {
    /* phase 8 — execute */
    const timeoutMs = options?.timeoutMs ?? cap.timeoutMs ?? internals.limits.actionTimeoutMs;
    const outcome = await executeWithGuards(internals, reg, {
      invocationId,
      capabilityId: cap.capabilityId,
      timeoutMs,
      externalSignal: options?.signal,
      idempotent: cap.idempotent,
      run: (signal) => {
        const live = reg.definition.actions?.[cap.name];
        if (!live) throw new Error("action handler missing");
        const actionCtx: AgentActionContext = {
          ...readCtx,
          invocationId,
          signal,
          ...(confirmation.evidence ? { confirmation: confirmation.evidence } : {}),
        };
        return live.execute(parsedInput, actionCtx);
      },
    });
    if (!outcome.ok) return finalize({ status: "error", error: outcome.payload });

    /* phase 9 — settle */
    const output = settleOutput(internals, outcome.value, cap.outputSchema);
    if ("error" in output) return finalize({ status: "error", error: output.error });
    args.setAuditPayload(undefined, output.value);
    return finalize({ status: "ok", output: output.value });
  } finally {
    releaseActionSlot(reg);
  }
}

async function executeProcedure(
  internals: RegistryInternals,
  args: CoreArgs,
  cap: ProcedureRuntime,
): Promise<AgentInvocationResult> {
  const { request, reg, invocationId, consumer, options, finalize } = args;

  /* phase 5 — input: locked-binding enforcement, reduced parse, bind, merge */
  const agentInput = (request.input ?? {}) as Record<string, JsonValue>;
  if (typeof agentInput !== "object" || agentInput === null || Array.isArray(agentInput)) {
    return finalize({
      status: "error",
      error: invalidInput(new AgentSchemaError([{ path: "", message: "input must be an object" }])),
    });
  }
  const suppliedLocked = Object.keys(agentInput).filter((k) => cap.lockedKeys.includes(k));
  if (suppliedLocked.length > 0) {
    return finalize({
      status: "error",
      error: {
        code: "INVALID_INPUT",
        message:
          "Some fields are bound to the application's UI state and cannot be supplied by the agent. Omit them and retry.",
        retry: "with-changes",
        details: { lockedFields: suppliedLocked },
      },
    });
  }
  try {
    fromJsonSchema(cap.reducedInputSchema).parse(agentInput);
  } catch (err) {
    return finalize({ status: "error", error: invalidInput(err) });
  }

  // bind() runs at EXECUTION time on live UI state (docs/05 rule 4).
  let bound: Record<string, JsonValue> = {};
  const bind = cap.binding.config.bind;
  if (bind) {
    try {
      bound = bind() ?? {};
    } catch (err) {
      internals.devWarn(`[agent-surface] bind() threw for ${cap.capabilityId}`, err);
      return finalize({ status: "error", error: bindingFailed() });
    }
  }

  const effective: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(agentInput)) {
    if (!cap.lockedKeys.includes(key)) effective[key] = value;
  }
  for (const key of cap.boundKeys) {
    const agentSupplied = cap.overridableKeys.has(key) && agentInput[key] !== undefined;
    if (!agentSupplied && bound[key] !== undefined) effective[key] = bound[key] as JsonValue;
  }

  // Merged object is validated against the FULL original schema (docs/05 rule 5):
  // the agent's part already validated, so a failure here is a binding bug.
  try {
    fromJsonSchema(cap.fullInputSchema).parse(effective);
  } catch (err) {
    internals.devWarn(
      `[agent-surface] merged input for ${cap.capabilityId} failed full-schema validation`,
      err,
    );
    return finalize({ status: "error", error: bindingFailed() });
  }
  args.setAuditPayload(effective, undefined);

  /* confirmation gate */
  const confirmation = gateConfirmation(internals, {
    ...args,
    effectiveInput: effective,
    declared: cap.confirmationFloor,
    description: cap.baseDescription,
    effect: cap.effect,
  });
  if ("error" in confirmation) return finalize({ status: "error", error: confirmation.error });

  /* phase 8 — forward to the executor (the server re-validates everything) */
  const executor = internals.executor;
  if (!executor) {
    return finalize({ status: "error", error: executionFailed("transport") });
  }
  const timeoutMs = options?.timeoutMs ?? internals.limits.procedureTimeoutMs;
  const outcome = await executeWithGuards(internals, reg, {
    invocationId,
    capabilityId: cap.capabilityId,
    timeoutMs,
    externalSignal: options?.signal,
    idempotent: cap.idempotent,
    run: (signal) =>
      executor.execute({
        path: cap.path,
        input: effective,
        info: {
          invocationId,
          consumer,
          signal,
          ...(confirmation.evidence ? { confirmation: confirmation.evidence } : {}),
        },
      }),
    procedureErrors: true,
  });
  if (!outcome.ok) return finalize({ status: "error", error: outcome.payload });

  /* phase 9 — settle */
  const output = settleOutput(
    internals,
    outcome.value,
    cap.outputJsonSchema ? fromJsonSchema(cap.outputJsonSchema) : undefined,
  );
  if ("error" in output) return finalize({ status: "error", error: output.error });
  args.setAuditPayload(undefined, output.value);
  return finalize({ status: "ok", output: output.value });
}

/* ───────────────────────── confirmation gate (docs/06) ───────────────────────── */

function gateConfirmation(
  internals: RegistryInternals,
  args: CoreArgs & {
    effectiveInput: JsonValue;
    declared: "never" | "optional" | "required";
    description: string;
    effect: string;
  },
):
  | { evidence?: { id: string; approvedAt: string } }
  | { error: AgentCapabilityErrorPayload } {
  const { request, reg, cap, consumer, escalations, effectiveInput, declared } = args;

  const activeEscalations = escalations.filter((e) => {
    if (!e.if) return true;
    try {
      return e.if({
        ...buildPolicyContext(internals, reg, cap, consumer, args.host),
        input: effectiveInput,
      });
    } catch {
      return true; // fail closed: a broken condition still confirms
    }
  });
  const effective = maxConfirmation(declared, activeEscalations.length > 0 ? "required" : "never");
  if (effective !== "required") return {};

  const summaryComposer = activeEscalations.find((e) => e.summary)?.summary;
  let summary: string;
  try {
    summary = summaryComposer
      ? summaryComposer(effectiveInput)
      : `${args.description} — input: ${JSON.stringify(effectiveInput)}`;
  } catch {
    summary = args.description;
  }
  summary = truncate(summary, 300);

  if (request.confirmationId) {
    const consumed = internals.confirmations.consume({
      confirmationId: request.confirmationId,
      capabilityId: cap.capabilityId,
      registrationId: reg.id,
      consumerId: consumer.id,
      input: effectiveInput,
    });
    if (consumed.ok) {
      return { evidence: { id: request.confirmationId, approvedAt: consumed.approvedAt } };
    }
    if (consumed.kind === "pending-again") {
      return { error: confirmationRequired(consumed.record, args.effect) };
    }
    return {
      error: {
        code: "CONFIRMATION_INVALID",
        message:
          consumed.reason === "denied"
            ? "The user declined this action. Do not retry; respect the decision."
            : consumed.reason === "expired"
              ? "The confirmation expired. Request a fresh confirmation."
              : consumed.reason === "consumed"
                ? "This confirmation was already used. Request a fresh confirmation if the action is still needed."
                : "The confirmation does not match this exact invocation.",
        retry: consumed.reason === "expired" ? "with-confirmation" : "no",
        details: { reason: consumed.reason },
      },
    };
  }

  const record = internals.confirmations.request({
    capabilityId: cap.capabilityId,
    registrationId: reg.id,
    consumerId: consumer.id,
    input: effectiveInput,
    summary,
  });
  return { error: confirmationRequired(record, args.effect) };
}

function confirmationRequired(
  record: { confirmationId: string; summary: string; expiresAt: string },
  effect: string,
): AgentCapabilityErrorPayload {
  return {
    code: "CONFIRMATION_REQUIRED",
    message:
      "User approval is required for this action. Wait for the user to resolve the confirmation, then retry with the confirmationId.",
    retry: "with-confirmation",
    details: {
      confirmationId: record.confirmationId,
      summary: record.summary,
      expiresAt: record.expiresAt,
      effect,
      origin: "client",
    },
  };
}

/* ───────────────────── shared input/output helpers ───────────────────── */

function invalidInput(err: unknown): AgentCapabilityErrorPayload {
  const issues =
    err instanceof AgentSchemaError
      ? err.issues.map((i) => ({ path: i.path, message: i.message }))
      : [{ path: "", message: "Input failed schema validation" }];
  return {
    code: "INVALID_INPUT",
    message: "The input does not match the capability's schema. Fix the listed issues and retry.",
    retry: "with-changes",
    details: { issues },
  };
}

function preconditionFailed(
  message: string,
  details?: Record<string, JsonValue>,
): AgentCapabilityErrorPayload {
  return {
    code: "PRECONDITION_FAILED",
    message: truncate(message, 300),
    retry: "with-changes",
    ...(details ? { details } : {}),
  };
}

function bindingFailed(): AgentCapabilityErrorPayload {
  return {
    code: "PRECONDITION_FAILED",
    message:
      "The UI-derived input binding could not be evaluated. Refresh the surface and check availability before retrying.",
    retry: "after-refresh",
    details: { reason: "binding-failed" },
  };
}

function settleOutput(
  internals: RegistryInternals,
  value: unknown,
  schema: { parse(v: unknown): unknown } | undefined,
): { value?: JsonValue } | { error: AgentCapabilityErrorPayload } {
  if (value === undefined) return {};
  let parsed: unknown = value;
  if (schema) {
    try {
      parsed = schema.parse(value);
    } catch (err) {
      internals.devError("[agent-surface] output failed schema validation", err);
      return { error: executionFailed("output-invalid") };
    }
  }
  if (!isJsonValue(parsed)) {
    if (internals.environment !== "production") {
      throw new DevDefectError(
        "capability output is not a JsonValue (functions, symbols, bigints, Dates, or cycles are defects — docs/03 §serialization)",
      );
    }
    return { error: executionFailed("output-invalid") };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(parsed);
  } catch {
    if (internals.environment !== "production") {
      throw new DevDefectError("capability output cannot be serialized to JSON");
    }
    return { error: executionFailed("output-invalid") };
  }
  if (serialized.length > internals.limits.maxOutputBytes) {
    return { error: executionFailed("output-too-large") };
  }
  return { value: parsed as JsonValue };
}

/* ─────────────────── execution guards: timeout/abort/unmount ─────────────────── */

type ExecutionOutcome =
  | { ok: true; value: unknown }
  | { ok: false; payload: AgentCapabilityErrorPayload };

function executeWithGuards(
  internals: RegistryInternals,
  reg: InternalRegistration,
  opts: {
    invocationId: string;
    capabilityId: string;
    timeoutMs: number;
    externalSignal: AbortSignal | undefined;
    idempotent: boolean;
    run: (signal: AbortSignal) => unknown;
    procedureErrors?: boolean;
  },
): Promise<ExecutionOutcome> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const entry: InFlightEntry = {
      settle(payload) {
        controller.abort();
        finish({ ok: false, payload });
      },
    };

    const onExternalAbort = (): void => {
      controller.abort();
      finish({
        ok: false,
        payload: {
          code: "CANCELLED",
          message: "The invocation was cancelled by the host.",
          retry: "yes",
        },
      });
    };

    const finish = (outcome: ExecutionOutcome): boolean => {
      if (settled) return false;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      reg.inFlight.delete(entry);
      opts.externalSignal?.removeEventListener("abort", onExternalAbort);
      resolve(outcome);
      return true;
    };

    const lateSettlement = (): void => {
      internals.recordAudit({
        type: "late-settlement",
        capabilityId: opts.capabilityId,
        registrationId: reg.id,
        invocationId: opts.invocationId,
      });
    };

    const handlerError = (err: unknown): ExecutionOutcome => {
      if (isAgentSurfaceError(err)) return { ok: false, payload: err.payload };
      internals.devError(`[agent-surface] handler failed for ${opts.capabilityId}`, err);
      return {
        ok: false,
        payload: executionFailed(opts.procedureErrors ? "transport" : "handler-error", {
          transient:
            opts.procedureErrors === true &&
            typeof err === "object" &&
            err !== null &&
            (err as { transient?: unknown }).transient === true,
        }),
      };
    };

    // The pipeline is async: the registration may have died (or the registry
    // been disposed) between resolution and execution. Re-check here.
    if (internals.disposed) {
      resolve({
        ok: false,
        payload: { code: "CANCELLED", message: "The registry was disposed.", retry: "no" },
      });
      return;
    }
    if (reg.status !== "active") {
      resolve({ ok: false, payload: unmounted("mid-flight") });
      return;
    }
    if (opts.externalSignal?.aborted) {
      resolve({
        ok: false,
        payload: {
          code: "CANCELLED",
          message: "The invocation was cancelled by the host.",
          retry: "yes",
        },
      });
      return;
    }
    opts.externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

    timer = setTimeout(() => {
      controller.abort();
      finish({
        ok: false,
        payload: {
          code: "TIMEOUT",
          message: opts.idempotent
            ? "The capability timed out. It is idempotent; retrying with a new invocationId is safe."
            : "The capability timed out and side effects may or may not have occurred. Verify state with an observation before repeating.",
          retry: opts.idempotent ? "yes" : "no",
          details: { timeoutMs: opts.timeoutMs, idempotent: opts.idempotent },
        },
      });
    }, opts.timeoutMs);

    reg.inFlight.add(entry);

    let returned: unknown;
    try {
      returned = opts.run(controller.signal);
    } catch (err) {
      finish(handlerError(err));
      return;
    }

    if (
      returned !== null &&
      (typeof returned === "object" || typeof returned === "function") &&
      typeof (returned as PromiseLike<unknown>).then === "function"
    ) {
      (returned as Promise<unknown>).then(
        (value) => {
          if (!finish({ ok: true, value })) lateSettlement();
        },
        (err) => {
          if (!finish(handlerError(err))) lateSettlement();
        },
      );
    } else {
      // Synchronous completion settles before any unmount abort (D16).
      finish({ ok: true, value: returned });
    }
  });
}

/* ─────────────── action serialization per component instance (D13) ─────────────── */

async function acquireActionSlot(
  internals: RegistryInternals,
  reg: InternalRegistration,
): Promise<"ok" | "overflow"> {
  if (!reg.actionQueue.running) {
    reg.actionQueue.running = true;
    return "ok";
  }
  if (reg.actionQueue.waiting.length >= internals.limits.actionQueueDepth) {
    return "overflow";
  }
  await new Promise<void>((resolve) => reg.actionQueue.waiting.push(resolve));
  return "ok"; // the releasing invocation hands the slot over
}

function releaseActionSlot(reg: InternalRegistration): void {
  const next = reg.actionQueue.waiting.shift();
  if (next) next();
  else reg.actionQueue.running = false;
}
