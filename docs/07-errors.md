# 07 — Error Model

> [!NOTE]
> **Status: Draft** (normative). Errors are part of the protocol: agents plan around them, adapters translate them, tests assert them. Vague errors are spec bugs.

> [!TIP]
> Errors here are not failures to apologize for — they are how the runtime *talks back* to the agent. `CAPABILITY_NOT_AVAILABLE` with a reason teaches the model the enabling step; `CONFIRMATION_REQUIRED` is a normal protocol turn; every code carries a machine-actionable `retry` hint. Implementers: the [per-code table](#code-by-code-specification) is the contract. Adapter authors: read [Principles](#principles) and the [mapping table](#adapter-mapping-guidance).

## Principles

1. **Results, not exceptions, at the boundary.** `invoke` returns a discriminated union ([03 §invocation](03-core-api.md#invocation)); `status: "error"` carries a serializable payload. JS exceptions are reserved for programmer misuse (structural definition defects, use-after-dispose).
2. **Typed and closed.** Agent-facing codes come from one closed enum. Adding a code is a spec change.
3. **Two audiences, two channels.** Every error has an *agent-safe* projection (code, message, retry, details) and an *operator* channel (cause, stack, internal context → audit/logs). The two never mix.
4. **Actionable.** Each code defines retry semantics an agent loop can act on mechanically.

## Shapes

```ts
export type AgentCapabilityErrorCode =
  | "CAPABILITY_NOT_FOUND"
  | "CAPABILITY_NOT_AVAILABLE"
  | "AMBIGUOUS_INSTANCE"
  | "COMPONENT_UNMOUNTED"
  | "STALE_CAPABILITY"
  | "INVALID_INPUT"
  | "NOT_AUTHENTICATED"
  | "NOT_AUTHORIZED"
  | "PRECONDITION_FAILED"
  | "CONFIRMATION_REQUIRED"
  | "CONFIRMATION_INVALID"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "CANCELLED"
  | "EXECUTION_FAILED";

export type AgentErrorRetry =
  | "no"                  // don't retry this request as-is
  | "yes"                 // safe to retry unchanged (idempotency window applies)
  | "after-refresh"       // re-snapshot, re-resolve target, then retry
  | "after-delay"         // retry after details.retryAfterMs
  | "with-confirmation"   // retry with confirmationId once approved
  | "with-changes";       // fix input per details, then retry

export interface AgentCapabilityErrorPayload {
  code: AgentCapabilityErrorCode;
  /** Agent-safe, imperative, ≤ 300 chars. */
  message: string;
  retry: AgentErrorRetry;
  /** Code-specific, agent-safe, JsonValue only. */
  details?: Record<string, JsonValue>;
}

/** Thrown form used inside policies/handlers; serialized at the boundary. */
export class AgentSurfaceError extends Error {
  constructor(payload: AgentCapabilityErrorPayload, opts?: { cause?: unknown });
  readonly payload: AgentCapabilityErrorPayload;
}
export function isAgentSurfaceError(e: unknown): e is AgentSurfaceError;

/** Structural defects at registration time. Always thrown, never agent-facing. */
export class AgentSurfaceDefinitionError extends Error {
  readonly code:
    | "INVALID_ID" | "INVALID_DEFINITION" | "UNSUPPORTED_SCHEMA"
    | "PLANE_VIOLATION" | "DUPLICATE_CAPABILITY" | "LIMIT_EXCEEDED";
}
```

## Code-by-code specification

For each: meaning · produced when · `retry` · agent-visible `details` · log-only info · adapter duty.

### `CAPABILITY_NOT_FOUND`
- **Meaning:** the id does not exist in this consumer's surface — never registered, long gone, or hidden by authority (indistinguishable on purpose, requirement 12 in [06](06-policies-and-security.md#the-deny-by-default-requirements-mapped)).
- **When:** resolution finds nothing and no tombstone matches.
- **Retry:** `after-refresh`. **Details:** none (no existence leaks). **Log-only:** whether a hidden registration actually matched. **Adapter:** refresh snapshot before the model's next step.

### `CAPABILITY_NOT_AVAILABLE`
- **Meaning:** exists and is visible, but currently disabled (state, `enabled: false`, or a policy `disable`).
- **When:** phase 3, or a discovery re-check downgrading to disabled.
- **Retry:** `after-refresh` (typically: perform the enabling step first). **Details:** `{ reason }` — same string as the descriptor's `unavailableReason`. **Adapter:** pass the reason through; it is planning fuel.

### `AMBIGUOUS_INSTANCE`
- **Meaning:** >1 live instance (or procedure reference) matches and none was specified.
- **Retry:** `with-changes`. **Details:** `{ instances: [{ instanceId, registrationId, description? }] }` (for procedures: `context` instead of description). **Adapter:** re-issue with an explicit target.

### `COMPONENT_UNMOUNTED`
- **Meaning:** the target registration existed recently and is gone (tombstone hit), or unmounted mid-execution.
- **Retry:** `after-refresh`. **Details:** `{ phase: "resolve" | "mid-flight" }`. **Log-only:** tombstone timestamps, late-settlement info. **Adapter:** refresh; if `mid-flight` on a non-idempotent action, surface uncertainty to the model ("the view changed while acting; verify state before repeating").

### `STALE_CAPABILITY`
- **Meaning:** the invocation references a superseded snapshot: `registrationId` mismatch with a live replacement, `surfaceId` from another page load, or version mismatch on a `destructive`/`external-side-effect` call.
- **Retry:** `after-refresh`. **Details:** `{ reason: "registration-replaced" | "surface-reloaded" | "surface-version-mismatch", liveRegistrationId? }`. **Adapter:** MUST refresh and re-resolve; MUST NOT strip the staleness tokens to force the call through.

### `INVALID_INPUT`
- **Meaning:** schema parse failed, or a locked bound field was supplied ([05 §binding](05-orpc-integration.md#binding-semantics-d7-d8--draft)).
- **Retry:** `with-changes`. **Details:** `{ issues: [{ path, message }], lockedFields? }` — issue messages come from the schema layer and MUST be safe (field-level, no values echoed for fields marked sensitive via schema `format`/meta). **Log-only:** offending raw input (dev only). **Adapter:** give issues to the model verbatim.

### `NOT_AUTHENTICATED`
- **Meaning:** no authenticated context where one is required.
- **Retry:** `no` (until the *user* signs in — never the agent's job; credential entry is out of scope for agents). **Details:** none. **Adapter:** tell the model to inform the user.

### `NOT_AUTHORIZED`
- **Meaning:** authenticated but not permitted (client policy or mapped server authz error).
- **Retry:** `no`. **Details:** `{ origin: "client" | "server" }` only — no permission names, no policy internals. **Log-only:** failing policy name, required permission. **Adapter:** do not loop; report.

### `PRECONDITION_FAILED`
- **Meaning:** input is schema-valid but state-invalid (`precondition`), or a procedure binding failed to evaluate.
- **Retry:** `with-changes` (or `after-refresh` when `details.reason: "binding-failed"`). **Details:** author-provided `{ message, …details }`; binding failures add `{ reason: "binding-failed" }`. **Adapter:** pass through.

### `CONFIRMATION_REQUIRED`
- **Meaning:** a user approval gate is active; not a failure ([06 §confirmation](06-policies-and-security.md#confirmation)).
- **Retry:** `with-confirmation`. **Details:** `{ confirmationId, summary, expiresAt, effect, origin: "client" | "server" }`. **Adapter:** in `wait` mode handle internally; in `two-phase` mode relay to the model with instructions to retry with `confirmationId` after approval. Never cached as terminal in the dedupe window.

### `CONFIRMATION_INVALID`
- **Meaning:** evidence rejected.
- **Retry:** `reason: "expired"` → `with-confirmation` (a fresh cycle); `"denied" | "consumed" | "mismatch"` → `no`. **Details:** `{ reason }`. **Log-only:** mismatch diff. **Adapter:** MUST NOT auto-retry a denial; a denial is a user decision the model must respect.

### `RATE_LIMITED`
- **Meaning:** client-side advisory limit or full action queue.
- **Retry:** `after-delay`. **Details:** `{ reason: "rate" | "queue-full", retryAfterMs }`. Never cached as terminal. **Adapter:** honor the delay; do not tight-loop.

### `TIMEOUT`
- **Meaning:** the handler/procedure exceeded its budget; the signal was aborted; **side effects may or may not have occurred**.
- **Retry:** `no` for non-idempotent capabilities (verify state first — say so in the message), `yes` for idempotent ones. **Details:** `{ timeoutMs, idempotent }`. **Log-only:** whether a late settlement arrived. **Adapter:** for non-idempotent, prompt a verification observation before any repeat. Cached as terminal (a retry needs a new invocationId — deliberate friction).

### `CANCELLED`
- **Meaning:** the host/adapter aborted (`InvokeOptions.signal`) or the registry was disposed.
- **Retry:** `yes` (new invocationId) if still relevant. **Details:** none.

### `EXECUTION_FAILED`
- **Meaning:** handler threw, output failed validation/serialization/size, or a transport/server error not mappable to a more precise code.
- **Retry:** `no` by default; `details.transient: true` MAY mark network-ish failures as `after-delay`. **Details:** `{ reason?: "handler-error" | "output-invalid" | "output-too-large" | "transport" , transient? }` plus a sanitized message. **Log-only:** full cause chain, stack, raw server error. **Sanitization is normative:** the agent-facing message MUST NOT contain stack frames, SQL/queries, internal URLs, header values, or environment details; implementations MUST build it from a allowlisted template, never from `error.message` pass-through of unknown causes.

## Adapter mapping guidance

| Adapter | `ok` | `error` |
|---|---|---|
| Embedded toolset | tool result = `output` (JSON) | tool result = the payload, plus `isError: true` where the provider supports it; retry hints kept in-band |
| WebMCP / MCP | content: JSON text of `output` | MCP tool error content with the payload JSON; MUST NOT use protocol-level errors for capability errors (those are for transport faults) |
| Testing | asserted directly | asserted directly (`expectError(result, "STALE_CAPABILITY")`) |

Adapters MUST preserve `code`, `retry`, and `details` losslessly; they MAY prepend a one-line natural-language rendering for weaker models.

## Registration-time errors

`AgentSurfaceDefinitionError` cases (always thrown, environment-independent — these are code bugs):

| Code | Trigger |
|---|---|
| `INVALID_ID` | grammar violation in `type`/capability name/instanceId |
| `INVALID_DEFINITION` | missing/empty description, unknown fields, non-JsonValue meta |
| `UNSUPPORTED_SCHEMA` | JSON Schema outside the [D19 subset](03-core-api.md#supported-json-schema-subset-d19-draft), too deep, too large |
| `PLANE_VIOLATION` | view action declaring a server effect; procedure binding without executor path |
| `DUPLICATE_CAPABILITY` | two capabilities with the same name in one definition |
| `LIMIT_EXCEEDED` | description/meta size caps |

Runtime rejection cases (dead handle + event, never thrown): duplicate `(type, instanceId)` under `"reject"`, guard rejection — see [03 §registry](03-core-api.md#registry).
