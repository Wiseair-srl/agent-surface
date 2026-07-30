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
  concurrencyGroupFor,
  consumerKeyOf,
  maxConfirmation,
  policiesFor,
} from "./internal.js";
import type { AgentCapabilityErrorPayload } from "./errors.js";
import { AgentSurfaceError, isAgentSurfaceError } from "./errors.js";
import { parseCapabilityId } from "./ids.js";
import { AgentSchemaError, fromJsonSchema } from "./schema.js";
import {
  CONFIRMATION_ESCALATION,
  composeAuthorizeChain,
  composeInvokeChain,
  evaluateDiscovery,
  type AgentInvocationPolicyContext,
  type AgentPolicyWithEscalation,
  type ConfirmationEscalation,
} from "./policy.js";
import type { AgentActionContext, AgentReadContext } from "./definition.js";
import { canonicalJson, fnv1a64, isJsonValue, randomBase62, truncate } from "./utils.js";

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

function invocationConflict(): AgentCapabilityErrorPayload {
  // Agent-visible details MUST NOT expose the prior request (docs/07).
  return {
    code: "INVOCATION_CONFLICT",
    message:
      "This invocation id was already used for a different request. Use a fresh invocation id if the new request is intentional.",
    retry: "with-changes",
    details: { reason: "id-reused-with-different-request" },
  };
}

function queueFull(retryAfterMs: number): AgentCapabilityErrorPayload {
  return {
    code: "RATE_LIMITED",
    message: "The queue for this capability is full. Retry shortly.",
    retry: "after-delay",
    details: { reason: "queue-full", retryAfterMs },
  };
}

function cancelled(message: string): AgentCapabilityErrorPayload {
  return { code: "CANCELLED", message, retry: "yes" };
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

/* ──────────────── phase 1: consumer-scoped dedupe + conflict (D22) ──────────────── */

/** Fingerprint of the request AS ISSUED (docs/18 §correction 2). */
function requestFingerprint(request: AgentInvocation): string {
  return fnv1a64(
    canonicalJson({
      capabilityId: request.capabilityId,
      registrationId: request.registrationId ?? null,
      instanceId: request.instanceId ?? null,
      surfaceVersion: request.surfaceVersion ?? null,
      input: request.input ?? null,
      confirmationId: request.confirmationId ?? null,
    }),
  );
}

export function performInvoke(
  internals: RegistryInternals,
  request: AgentInvocation,
  options?: InvokeOptions,
): Promise<AgentInvocationResult> {
  if (internals.disposed) {
    throw new Error("invoke() called on a disposed registry");
  }
  const invocationId = request.invocationId ?? `inv_${randomBase62(12)}`;
  const consumer = options?.consumer ?? DEFAULT_CONSUMER;
  const consumerKey = consumerKeyOf(consumer);
  const fingerprint = requestFingerprint(request);
  const dedupeKey = `${consumerKey} ${invocationId}`;

  pruneDedupe(internals);
  const existing = internals.dedupe.get(dedupeKey);
  if (existing) {
    if (existing.kind === "inflight") {
      if (existing.fingerprint === fingerprint) return existing.promise; // join, don't re-execute
      return Promise.resolve(conflictResult(internals, request, invocationId, consumer));
    }
    if (existing.expiresAt > internals.now()) {
      if (existing.fingerprint === fingerprint) return Promise.resolve(existing.result);
      return Promise.resolve(conflictResult(internals, request, invocationId, consumer));
    }
    internals.dedupe.delete(dedupeKey); // expired key: a new attempt (bounded window)
  }

  const promise = runPipeline(internals, request, invocationId, consumer, consumerKey, options);
  internals.dedupe.set(dedupeKey, { kind: "inflight", fingerprint, promise });
  promise.then(
    (result) => {
      // Terminal = ok and every error except CONFIRMATION_REQUIRED / RATE_LIMITED
      // (expected-retry outcomes; INVOCATION_CONFLICT never reaches here).
      const terminal =
        result.status === "ok" ||
        (result.error.code !== "CONFIRMATION_REQUIRED" && result.error.code !== "RATE_LIMITED");
      if (terminal) {
        internals.dedupe.set(dedupeKey, {
          kind: "terminal",
          fingerprint,
          result,
          expiresAt: internals.now() + internals.limits.dedupeCacheTtlMs,
        });
        pruneDedupe(internals);
      } else {
        internals.dedupe.delete(dedupeKey);
      }
    },
    () => {
      internals.dedupe.delete(dedupeKey);
    },
  );
  return promise;
}

/** Fail-closed conflict envelope: emitted through events/audit, never cached. */
function conflictResult(
  internals: RegistryInternals,
  request: AgentInvocation,
  invocationId: string,
  consumer: AgentConsumer,
): AgentInvocationResult {
  internals.emit({
    type: "invocation-started",
    invocationId,
    capabilityId: request.capabilityId,
    consumerId: consumer.id,
  });
  const error = invocationConflict();
  const result: AgentInvocationResult = {
    status: "error",
    invocationId,
    capabilityId: request.capabilityId,
    error,
    surfaceVersion: String(internals.version),
  };
  internals.emit({
    type: "invocation-settled",
    invocationId,
    capabilityId: request.capabilityId,
    status: "error",
    code: error.code,
    durationMs: 0,
  });
  internals.recordAudit({
    type: "invocation-settled",
    capabilityId: request.capabilityId,
    invocationId,
    consumerId: consumerKeyOf(consumer),
    status: "error",
    code: error.code,
    durationMs: 0,
  });
  return result;
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

/* ───────────────────────────── the 10 phases ───────────────────────────── */

interface ResolvedTarget {
  reg: InternalRegistration;
  cap: CapabilityRuntime;
}

async function runPipeline(
  internals: RegistryInternals,
  request: AgentInvocation,
  invocationId: string,
  consumer: AgentConsumer,
  consumerKey: string,
  options?: InvokeOptions,
): Promise<AgentInvocationResult> {
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
  // §7.1 observability: queue wait and execution duration are distinct.
  let queueWaitMsForAudit: number | undefined;
  let executionMsForAudit: number | undefined;

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
        consumerId: consumerKey,
        status: result.status,
        ...(result.status === "error" ? { code: result.error.code } : {}),
        durationMs,
        ...(queueWaitMsForAudit !== undefined ? { queueWaitMs: queueWaitMsForAudit } : {}),
        ...(executionMsForAudit !== undefined ? { executionMs: executionMsForAudit } : {}),
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
    /* phase 2 — resolve + staleness tokens */
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
        consumerId: consumerKey,
      });
    }

    /* phase 3 — availability (re-evaluated, never trusted from discovery) */
    const availability = computeAvailability(internals, reg, cap);
    if (!availability.available) {
      return finalize({ status: "error", error: notAvailable(availability.reason) });
    }

    /* phase 4 — pre-input authority. The onDiscovery re-run covers pure
       discovery policies (hide ⇒ NOT_FOUND, disable ⇒ NOT_AVAILABLE);
       onAuthorize gates run onion-style with NO agent input in scope (D21). */
    const host = internals.host();
    const chain = policiesFor(internals, reg, cap);
    const policyCtx = buildPolicyContext(internals, reg, cap, consumer, host);
    const discovery = evaluateDiscovery(
      chain.filter((p) => !p.onAuthorize && !p.onInvoke),
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
        consumerKey,
        host,
        reg,
        cap,
        chain,
        policyCtx,
        escalations,
        options,
        finalize,
        setAuditPayload: (input, output) => {
          if (input !== undefined) inputForAudit = input;
          if (output !== undefined) outputForAudit = output;
        },
        setTimings: (timings) => {
          if (timings.queueWaitMs !== undefined) queueWaitMsForAudit = timings.queueWaitMs;
          if (timings.executionMs !== undefined) executionMsForAudit = timings.executionMs;
        },
      });

    try {
      return await composeAuthorizeChain(chain, policyCtx, core);
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
    // Tombstones are TTL-bound: an expired one no longer proves recency.
    const tombstone = internals.tombstones.get(request.registrationId);
    const tombstoned = tombstone !== undefined && tombstone.expiresAt > internals.now();
    if (candidates.length > 0) {
      const reason = tombstoned
        ? ("registration-replaced" as const)
        : ("surface-reloaded" as const);
      return { error: stale(reason, candidates[0]?.reg.id) };
    }
    if (tombstoned) {
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

/* ───────────────────────── phases 5–10 per kind ───────────────────────── */

interface CoreArgs {
  request: AgentInvocation;
  invocationId: string;
  consumer: AgentConsumer;
  consumerKey: string;
  host: Record<string, unknown>;
  reg: InternalRegistration;
  cap: CapabilityRuntime;
  chain: ReadonlyArray<AgentPolicyWithEscalation>;
  policyCtx: ReturnType<typeof buildPolicyContext>;
  escalations: ConfirmationEscalation[];
  options: InvokeOptions | undefined;
  finalize: (
    body:
      | { status: "ok"; output?: JsonValue }
      | { status: "error"; error: AgentCapabilityErrorPayload },
  ) => AgentInvocationResult;
  setAuditPayload: (input?: JsonValue, output?: JsonValue) => void;
  setTimings: (timings: { queueWaitMs?: number; executionMs?: number }) => void;
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

/** Phase 6: onInvoke onion over the validated effective input (D21). */
function runInvokePolicies(
  args: CoreArgs,
  effectiveInput: JsonValue,
  downstream: () => Promise<AgentInvocationResult>,
): Promise<AgentInvocationResult> {
  const invokeCtx: AgentInvocationPolicyContext = {
    ...args.policyCtx,
    invocationId: args.invocationId,
    effectiveInput,
  };
  return composeInvokeChain(args.chain, invokeCtx, downstream);
}

async function executeObservation(
  internals: RegistryInternals,
  args: CoreArgs,
  cap: ObservationRuntime,
): Promise<AgentInvocationResult> {
  // Observations skip input parsing, confirmation, and the action queue;
  // their effective input is vacuously {} for phase-6 policies.
  const { reg, invocationId, consumer, consumerKey, host, options, finalize } = args;
  const readCtx: AgentReadContext = {
    capabilityId: cap.capabilityId,
    registrationId: reg.id,
    consumer,
    host,
  };
  const run = async (): Promise<AgentInvocationResult> => {
    /* phase 8 — bounded observation admission (D24) */
    const queueStart = internals.now();
    const slot = await acquireObservationSlot(internals, consumerKey);
    args.setTimings({ queueWaitMs: internals.now() - queueStart });
    if (slot === "overflow") {
      return finalize({ status: "error", error: queueFull(250) });
    }
    if (slot === "cancelled") {
      return finalize({
        status: "error",
        error: { ...cancelled("The registry was disposed."), retry: "no" },
      });
    }
    try {
      const timeoutMs =
        options?.timeoutMs ?? cap.timeoutMs ?? internals.limits.observationTimeoutMs;
      const executeStart = internals.now();
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
      args.setTimings({ executionMs: internals.now() - executeStart });
      if (!outcome.ok) return finalize({ status: "error", error: outcome.payload });
      const output = settleOutput(internals, outcome.value, cap.outputSchema);
      if ("error" in output) return finalize({ status: "error", error: output.error });
      return finalize({ status: "ok", output: output.value });
    } finally {
      releaseObservationSlot(internals, consumerKey);
    }
  };
  return runInvokePolicies(args, {}, run);
}

async function executeAction(
  internals: RegistryInternals,
  args: CoreArgs,
  cap: ActionRuntime,
): Promise<AgentInvocationResult> {
  const { request, reg, invocationId, consumer, host, options, finalize } = args;

  /* phase 5 — validated effective input */
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

  const run = async (): Promise<AgentInvocationResult> => {
    /* phase 6 (tail) — confirmation decision over the effective input */
    const confirmation = gateConfirmation(internals, {
      ...args,
      effectiveInput: parsedInput,
      declared: cap.confirmation,
      description: cap.description,
      effect: cap.effect,
    });
    if ("error" in confirmation) return finalize({ status: "error", error: confirmation.error });

    /* phase 7 — precondition */
    const livePrecondition = reg.definition.actions?.[cap.name]?.precondition;
    if (livePrecondition) {
      try {
        const failure = livePrecondition(parsedInput, readCtx);
        if (failure && typeof failure.message === "string") {
          return finalize({
            status: "error",
            error: preconditionFailed(failure.message, failure.details),
          });
        }
      } catch (err) {
        if (isAgentSurfaceError(err)) return finalize({ status: "error", error: err.payload });
        if (
          !(err instanceof Error) &&
          typeof err === "object" &&
          err !== null &&
          typeof (err as { message?: unknown }).message === "string"
        ) {
          const failure = err as { message: string; details?: Record<string, JsonValue> };
          return finalize({
            status: "error",
            error: preconditionFailed(failure.message, failure.details),
          });
        }
        internals.devError(`[agent-surface] precondition threw for ${cap.capabilityId}`, err);
        return finalize({ status: "error", error: executionFailed("handler-error") });
      }
    }

    /* phase 8 — concurrency: per-group admission, default per instance (D13/D25) */
    const queueStart = internals.now();
    const slot = await acquireActionSlot(internals, reg, cap);
    args.setTimings({ queueWaitMs: internals.now() - queueStart });
    if (slot === "overflow") {
      return finalize({ status: "error", error: queueFull(250) });
    }

    try {
      /* phase 9 — execute; navigation actions settle on handler settlement (D23) */
      const timeoutMs = options?.timeoutMs ?? cap.timeoutMs ?? internals.limits.actionTimeoutMs;
      const executeStart = internals.now();
      const outcome = await executeWithGuards(internals, reg, {
        invocationId,
        capabilityId: cap.capabilityId,
        timeoutMs,
        externalSignal: options?.signal,
        idempotent: cap.idempotent,
        navigationSettlement: cap.effect === "navigation",
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
      args.setTimings({ executionMs: internals.now() - executeStart });
      if (!outcome.ok) return finalize({ status: "error", error: outcome.payload });

      /* phase 10 — settle */
      const output = settleOutput(internals, outcome.value, cap.outputSchema);
      if ("error" in output) return finalize({ status: "error", error: output.error });
      args.setAuditPayload(undefined, output.value);
      return finalize({ status: "ok", output: output.value });
    } finally {
      releaseActionSlot(internals, reg, cap);
    }
  };
  return runInvokePolicies(args, parsedInput, run);
}

async function executeProcedure(
  internals: RegistryInternals,
  args: CoreArgs,
  cap: ProcedureRuntime,
): Promise<AgentInvocationResult> {
  const { request, reg, invocationId, consumer, options, finalize } = args;

  /* phase 5 — validated effective input:
     locked-field rejection → reduced parse → bind → merge → full-schema parse */
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

  const run = async (): Promise<AgentInvocationResult> => {
    /* phase 6 (tail) — confirmation decision over the effective input */
    const confirmation = gateConfirmation(internals, {
      ...args,
      effectiveInput: effective,
      declared: cap.confirmationFloor,
      description: cap.baseDescription,
      effect: cap.effect,
    });
    if ("error" in confirmation) return finalize({ status: "error", error: confirmation.error });

    /* phase 8 — concurrency: one group per procedure identity by default (D25) */
    const queueStart = internals.now();
    const slot = await acquireActionSlot(internals, reg, cap);
    args.setTimings({ queueWaitMs: internals.now() - queueStart });
    if (slot === "overflow") {
      return finalize({ status: "error", error: queueFull(250) });
    }

    try {
      /* phase 9 — forward to the executor (the server re-validates everything) */
      const executor = internals.executor;
      if (!executor) {
        return finalize({ status: "error", error: executionFailed("transport") });
      }
      const timeoutMs = options?.timeoutMs ?? internals.limits.procedureTimeoutMs;
      const executeStart = internals.now();
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
      args.setTimings({ executionMs: internals.now() - executeStart });
      if (!outcome.ok) return finalize({ status: "error", error: outcome.payload });

      /* phase 10 — settle */
      const output = settleOutput(
        internals,
        outcome.value,
        cap.outputJsonSchema ? fromJsonSchema(cap.outputJsonSchema) : undefined,
      );
      if ("error" in output) return finalize({ status: "error", error: output.error });
      args.setAuditPayload(undefined, output.value);
      return finalize({ status: "ok", output: output.value });
    } finally {
      releaseActionSlot(internals, reg, cap);
    }
  };
  return runInvokePolicies(args, effective, run);
}

/* ───────────────────── confirmation gate (docs/06, D21) ───────────────────── */

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
  const { request, reg, cap, consumerKey, escalations, effectiveInput, declared } = args;

  const activeEscalations = escalations.filter((e) => {
    if (!e.if) return true;
    try {
      return e.if({ ...args.policyCtx, effectiveInput });
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

  // Canonical request digest (D21): what the user approves is exactly what
  // executes. The canonical string itself is the digest — comparison stays
  // exact-value, never hash-only.
  const digest = canonicalJson({
    surfaceId: internals.surfaceId,
    registrationId: reg.id,
    capabilityId: cap.capabilityId,
    consumerKey,
    effectiveInput,
    effect: args.effect,
  });

  if (request.confirmationId) {
    const consumed = internals.confirmations.consume({
      confirmationId: request.confirmationId,
      digest,
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
    consumerKey,
    effect: args.policyCtx.effect,
    input: effectiveInput,
    summary,
    digest,
  });
  if (record === "overflow") {
    // Bounded pending store (D24): fail closed, no record created.
    return { error: queueFull(1000) };
  }
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

/* ─────────────── execution guards: timeout/abort/unmount (D16/D23) ─────────────── */

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
    /** D23: unregistration aborts the signal but never settles the invocation. */
    navigationSettlement?: boolean;
  },
): Promise<ExecutionOutcome> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const entry: InFlightEntry = {
      onUnregister() {
        controller.abort();
        if (!opts.navigationSettlement) {
          finish({ ok: false, payload: unmounted("mid-flight") });
        }
        // Navigation invocations settle on handler settlement/timeout/cancel
        // only — a committed transition must not be overwritten (AS-NAV-001).
      },
      onDispose() {
        controller.abort();
        finish({
          ok: false,
          payload: { code: "CANCELLED", message: "The registry was disposed.", retry: "no" },
        });
      },
    };

    const onExternalAbort = (): void => {
      controller.abort();
      finish({
        ok: false,
        payload: cancelled("The invocation was cancelled by the host."),
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
      // D23: a navigation handler rejecting after its signal was aborted
      // abandoned the transition — that is a cancellation, not a failure.
      if (opts.navigationSettlement && controller.signal.aborted) {
        return { ok: false, payload: cancelled("The navigation was abandoned after its owner unmounted.") };
      }
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
        payload: cancelled("The invocation was cancelled by the host."),
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
  cap: ActionRuntime | ProcedureRuntime,
): Promise<"ok" | "overflow"> {
  const { key, max, depth } = concurrencyGroupFor(cap, internals.limits);
  let group = reg.concurrencyGroups.get(key);
  if (!group) {
    group = { running: 0, max, depth, waiting: [] };
    reg.concurrencyGroups.set(key, group);
  }
  if (group.running < group.max) {
    group.running += 1;
    return "ok";
  }
  if (group.waiting.length >= group.depth) {
    // Nothing was reserved, so an idle group must not linger in the map.
    if (group.running === 0 && group.waiting.length === 0) reg.concurrencyGroups.delete(key);
    return "overflow";
  }
  await new Promise<void>((resolve) => group.waiting.push(resolve));
  return "ok"; // the releasing invocation hands the slot over
}

function releaseActionSlot(
  internals: RegistryInternals,
  reg: InternalRegistration,
  cap: ActionRuntime | ProcedureRuntime,
): void {
  const { key } = concurrencyGroupFor(cap, internals.limits);
  const group = reg.concurrencyGroups.get(key);
  if (!group) return;
  const next = group.waiting.shift();
  // A handed-over slot stays counted: `running` never dips between the two.
  if (!next) group.running -= 1;
  else next();
  if (group.running === 0 && group.waiting.length === 0) reg.concurrencyGroups.delete(key);
}

/* ─────────────── bounded observation admission per consumer (D24) ─────────────── */

function acquireObservationSlot(
  internals: RegistryInternals,
  consumerKey: string,
): Promise<"ok" | "overflow" | "cancelled"> {
  const adm = internals.observationAdmission;
  const perCap = internals.limits.maxConcurrentObservationsPerConsumer;
  const totalCap = internals.limits.maxConcurrentObservationsTotal;
  const held = adm.perConsumer.get(consumerKey) ?? 0;
  if (held < perCap && adm.total < totalCap) {
    adm.perConsumer.set(consumerKey, held + 1);
    adm.total += 1;
    return Promise.resolve("ok");
  }
  let queued = 0;
  for (const waiter of adm.waiting) {
    if (waiter.consumerKey === consumerKey) queued += 1;
  }
  if (queued >= internals.limits.maxQueuedObservationsPerConsumer) {
    return Promise.resolve("overflow");
  }
  return new Promise((resolve) => {
    adm.waiting.push({
      consumerKey,
      admit: (admitted) => resolve(admitted ? "ok" : "cancelled"),
    });
  });
}

function releaseObservationSlot(internals: RegistryInternals, consumerKey: string): void {
  const adm = internals.observationAdmission;
  adm.total = Math.max(0, adm.total - 1);
  const held = adm.perConsumer.get(consumerKey) ?? 0;
  if (held <= 1) adm.perConsumer.delete(consumerKey);
  else adm.perConsumer.set(consumerKey, held - 1);

  // Wake the first arrival-ordered waiter whose consumer is under its cap:
  // FIFO within a consumer, no cross-consumer starvation (AS-OBS-002).
  const perCap = internals.limits.maxConcurrentObservationsPerConsumer;
  const totalCap = internals.limits.maxConcurrentObservationsTotal;
  for (let i = 0; i < adm.waiting.length; i++) {
    const waiter = adm.waiting[i];
    if (!waiter) continue;
    const waiterHeld = adm.perConsumer.get(waiter.consumerKey) ?? 0;
    if (waiterHeld < perCap && adm.total < totalCap) {
      adm.waiting.splice(i, 1);
      adm.perConsumer.set(waiter.consumerKey, waiterHeld + 1);
      adm.total += 1;
      waiter.admit(true);
      return;
    }
  }
}

/** Dispose path: drain queued observation waiters as cancelled (leak-free). */
export function drainObservationQueues(internals: RegistryInternals): void {
  const adm = internals.observationAdmission;
  const waiting = adm.waiting.splice(0);
  for (const waiter of waiting) waiter.admit(false);
}
