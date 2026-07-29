# 17 — Maintainer Directive: Taking `agent-surface` to 10/10

> [!IMPORTANT]
> **Audience:** the coding agent acting as maintainer and principal implementer of `agent-surface`.
>
> **Status:** execution directive derived from the design specification as of 2026-07-29. This document is not a parallel source of truth. Whenever it changes behavior, update the normative documents (`01`–`09`), the decision log (`13`), the implementation plan (`14`), and the completeness review (`15`) in the same pull request.
>
> **Mission:** turn the current design-phase specification into a production-grade, internally coherent, executable contract that can be adopted progressively in a legacy React application and later published without architectural regret.

---

## 1. Definition of “10/10”

The project reaches **10/10 design quality** when:

1. its core invariants are small, explicit, non-contradictory, and enforced by types plus runtime checks;
2. every security-sensitive decision is made by the runtime or authoritative server, never by model prose;
3. the `view:` and `domain:` planes cannot be accidentally duplicated or blurred;
4. discovery, validation, confirmation, invocation, concurrency, staleness, and error behavior form one coherent protocol;
5. adapters cannot silently weaken the protocol;
6. lifecycle behavior is deterministic under React Strict Mode, Suspense, route transitions, HMR, unmount, cancellation, and retries;
7. every normative guarantee is testable without an LLM.

The project reaches **10/10 maturity** when:

1. the spec and implementation are traceably aligned;
2. all normative requirements have named conformance tests;
3. at least one realistic application uses the presentation plane and one contextual domain mutation end to end;
4. CI exercises supported React, TypeScript, schema-library, runtime, and bundling matrices;
5. public APIs have compatibility tests, migration notes, and release discipline;
6. performance and memory bounds are measured rather than aspirational;
7. failure behavior is observable, bounded, documented, and recoverable;
8. maintainers can reject scope creep using explicit release gates and non-goals.

Do not optimize for the appearance of completeness. Optimize for a small, proven contract whose guarantees survive real application behavior.

---

## 2. Preserve these invariants at all costs

These are the project’s strongest decisions. Do not dilute them to simplify an adapter or satisfy a demo.

### 2.1 Explicit capabilities, never implicit UI exposure

- No DOM scanning.
- No selector, coordinate, screenshot, text-position, or accessibility-tree identity.
- No “expose all controls” switch.
- A capability exists only through reviewed registration code.

### 2.2 Two planes, one implementation per operation

- `view:` capabilities exist only because a mounted view exists.
- `domain:` capabilities are existing authoritative backend procedures.
- A frontend component may reference a domain procedure, bind UI-derived inputs, and add stricter UX policy.
- It must never reimplement the domain operation as a frontend action.
- One operation must have one canonical identity and one execution path.

### 2.3 The registry is the in-page source of truth

- React, oRPC, tests, and transports are adapters around the registry.
- `core` remains provider-neutral, framework-neutral, DOM-free, and runtime-dependency-free.
- No adapter-specific type may leak into `core`.

### 2.4 Lifecycle is part of authority

- Registration exists only for a committed, enabled component lifetime.
- Structural identity is immutable for a registration.
- Remount or structural change creates a new `registrationId`.
- Stale calls fail; they are never forced through by stripping tokens.
- Unregistered executable references must be released.

### 2.5 The browser is not a security boundary

- Client policies provide honest discovery, safer UX, contextual gating, confirmation, and audit.
- The server rechecks authentication, authorization, tenant, input, rate, and approval for every domain call.
- No client-only mechanism may be described as authoritative for persistent effects.

### 2.6 Runtime decisions, not model judgment

- Descriptions communicate intent; they do not grant permission.
- Confirmation requirements, availability, authorization, binding, staleness, and concurrency are runtime rules.
- Agent-facing errors remain typed, closed, serializable, actionable, and safe.

### 2.7 Deterministic testing without an LLM

- The testing package is a reference consumer.
- If a guarantee cannot be tested through public or deliberate testing seams, the API is incomplete.
- Model-based evals may supplement conformance tests but never replace them.

---

## 3. Mandatory design corrections before implementation proceeds

Treat the following as **P0 specification bugs**. Resolve them in the normative documents and decision log before implementing the affected runtime paths.

## 3.1 Correct the invocation pipeline: validated effective input must precede input-aware policy and confirmation

### Current problem

The current architecture places the general policy chain, including confirmation, before the input phase. The oRPC binding design computes and validates the **effective input** during the later input phase:

```text
agent input
  + locked-field enforcement
  + live UI binding
  + merge
  + full original-schema validation
  = effective input
```

Confirmation evidence is supposed to bind to the exact operation and input the user approved. A confirmation decision cannot truthfully bind to effective input before that effective input exists and has been validated.

This is a protocol contradiction, not a minor ordering preference.

### Required correction

Split policy concerns into pre-input authorization and post-input invocation policy. Adopt this normative order:

```text
 1. dedupe lookup and request-conflict check
 2. resolve target and validate staleness tokens
 3. re-evaluate component/capability availability
 4. pre-input authority policies
      - authentication
      - authorization
      - tenant
      - environment
      - discovery consistency
 5. construct validated effective input
      - reject supplied locked fields
      - parse agent-facing input
      - evaluate live bindings
      - merge according to overridable-field rules
      - validate against full original schema
 6. post-input invocation policies
      - input-aware rate decisions
      - confirmation decision
      - confirmation evidence validation
      - audit enrichment
 7. capability precondition against effective input and live state
 8. acquire concurrency slot
 9. execute with timeout and AbortSignal
10. settle
      - validate and serialize output
      - classify final result
      - update dedupe record
      - emit audit and ordered events
```

### Required API shape

Prefer an explicit split instead of relying on conventions around optional `input`:

```ts
export interface AgentPolicy {
  name: string;
  onDiscovery?(ctx: AgentPolicyContext): DiscoveryDecision;

  /** No unvalidated agent input is available here. */
  onAuthorize?(
    ctx: AgentAuthorizationContext,
    next: () => Promise<AgentInvocationResult>,
  ): Promise<AgentInvocationResult>;

  /** Receives only the validated effective input. */
  onInvoke?(
    ctx: AgentInvocationPolicyContext,
    next: () => Promise<AgentInvocationResult>,
  ): Promise<AgentInvocationResult>;
}

export interface AgentInvocationPolicyContext
  extends AgentAuthorizationContext {
  invocationId: string;
  effectiveInput: JsonValue;
}
```

Alternative API designs are acceptable only if the type system makes it impossible for confirmation or another input-aware policy to consume raw, unbound, or schema-invalid input.

### Required confirmation binding

Confirmation evidence must bind to a canonical request digest containing at least:

```ts
{
  surfaceId,
  registrationId,
  capabilityId,
  consumerKey,
  effectiveInput,
  effect,
}
```

Use deterministic canonical JSON encoding before hashing or deep comparison. Define number, object-key ordering, omitted `undefined`, and array-order behavior. Evidence remains single-use and TTL-bound.

### Required tests

- Confirmation summary receives bound values, not just agent-visible values.
- A binding value changed after discovery but before invocation is reflected in the confirmation.
- A binding value changed after approval causes `CONFIRMATION_INVALID`, not execution.
- A malformed binding fails before a confirmation record is created.
- A supplied locked field fails before confirmation.
- Approval for input A cannot execute input B.
- Approval cannot be replayed across consumer, registration, capability, or page reload.

### Documents to update

- `02-architecture.md`: normative pipeline and diagrams.
- `03-core-api.md`: invocation and policy contexts.
- `05-orpc-integration.md`: binding and execution flow.
- `06-policies-and-security.md`: policy composition and confirmation protocol.
- `07-errors.md`: error production phases.
- `08-testing.md`: conformance recipes.
- `13-open-questions.md`: add and settle a new decision for policy/input ordering.
- `15-completeness-review.md`: remove the inconsistency only after code proves it.

---

## 3.2 Make invocation identity collision-safe and consumer-scoped

### Current problem

The current design promises at-most-once execution per `invocationId`, while adapters derive that value from provider tool-call IDs. Those IDs are not guaranteed to be globally unique across:

- consumers;
- adapters;
- conversations;
- providers;
- page lifetimes;
- reconnects.

A cache keyed only by `invocationId` can join or return the result of a different request. Reusing an ID with different input must never silently succeed.

### Required correction

Define an invocation identity key and a canonical request fingerprint.

Recommended key:

```ts
type InvocationKey = {
  surfaceId: string;
  consumerKey: string;
  invocationId: string;
};
```

`consumerKey` must be a stable runtime-normalized identity, not just an optional display ID. Define how anonymous consumers are isolated. Adapter instances should provide a stable namespace when the upstream provider does not.

Recommended request fingerprint:

```ts
type InvocationFingerprint = {
  capabilityId: string;
  registrationId: string;
  effectiveInputDigest: string;
  confirmationId?: string;
};
```

The dedupe store must behave as follows:

1. unknown key: create an in-flight record;
2. same key + same fingerprint: join in-flight or return cached terminal result;
3. same key + different fingerprint: fail closed with a dedicated conflict error;
4. expired key: treat as a new attempt and document the bounded idempotency window.

### Add a dedicated error

Add a closed error code such as:

```ts
"INVOCATION_CONFLICT"
```

Recommended semantics:

```ts
{
  code: "INVOCATION_CONFLICT",
  message: "This invocation id was already used for a different request.",
  retry: "with-changes",
  details: { reason: "id-reused-with-different-request" }
}
```

Do not expose prior input, capability, or sensitive fingerprint material in agent-visible details.

### Required tests

- Same consumer + same ID + same request joins exactly once.
- Same consumer + same ID + different input fails conflict.
- Same consumer + same ID + different capability fails conflict.
- Different consumers may reuse the same provider tool-call ID safely.
- Different page loads cannot collide.
- Confirmation retry behavior is explicitly tested with the chosen same-ID/new-ID rule.
- LRU and TTL eviction are deterministic under fake clocks.

### Documents to update

- `03-core-api.md`: invocation contract and dedupe semantics.
- `07-errors.md`: new code and adapter mapping.
- `08-testing.md`: conflict recipes.
- `09-adapters.md`: namespace obligations.
- `13-open-questions.md`: amend D14.
- `14-implementation-plan.md`: make conflict behavior an M4 acceptance criterion.

---

## 3.3 Define successful navigation independently from owner unmount timing

### Current problem

A `view:` navigation action may synchronously or asynchronously trigger the unmount of the component that registered it. The current “first settle wins” rule can classify a successful route transition as `COMPONENT_UNMOUNTED`, depending on timing.

That result is semantically unstable and encourages unnecessary retries.

### Required correction

Define a navigation completion contract. Recommended design:

```ts
export interface AgentNavigationResult {
  accepted: true;
  destination?: AgentRouteInfo;
}
```

A navigation action is successful when the host router accepts or commits the requested transition according to an injected router adapter. Unmount after that acceptance must not overwrite success.

Do not special-case arbitrary handlers by timing heuristics. Provide an explicit host seam, for example:

```ts
export interface AgentNavigationHost {
  navigate(request: AgentNavigationRequest, signal: AbortSignal):
    Promise<AgentNavigationResult>;
}
```

Or require the action handler to return an explicit committed/accepted result before unmount. Choose one contract and test it.

### Required tests

- Navigation commits and owner unmounts in the same task: result is `ok`.
- Navigation is rejected before commit: typed failure.
- Owner unmounts before router acceptance: `COMPONENT_UNMOUNTED` or `CANCELLED`, according to the chosen contract.
- A timeout after the router already accepted does not report failure.
- Route snapshot refresh occurs after commit.

### Documents to update

- `01-concepts.md`: navigation effect semantics.
- `03-core-api.md`: action result and unmount rules.
- `04-react-api.md`: route transition guidance.
- `07-errors.md`: `COMPONENT_UNMOUNTED` boundary.
- `08-testing.md`: navigation recipes.
- `13-open-questions.md`: revisit D16 with explicit navigation semantics.

---

## 3.4 Replace unlimited observations with bounded read concurrency

### Current problem

Observations may be asynchronous and have non-zero timeouts, yet the current design allows unlimited concurrent observations. A buggy model, adapter, or retry loop can create avoidable load and memory pressure.

### Required correction

Add bounded observation concurrency with conservative defaults:

```ts
limits: {
  maxConcurrentObservationsPerConsumer: 8,
  maxConcurrentObservationsTotal: 32,
  maxQueuedObservationsPerConsumer: 8,
}
```

When the limit is reached, return `RATE_LIMITED` with a machine-actionable reason and optional `retryAfterMs`. Do not let observations consume the action queue.

Measure defaults in the example application before stabilizing them.

### Required tests

- Per-consumer and global limits are independent.
- One consumer cannot starve another.
- Cancellation and timeout release slots.
- Queued observation removal is leak-free on consumer disposal.
- Rate-limit error details contain no internal queue state beyond safe planning information.

---

## 3.5 Make action concurrency configurable without losing safe defaults

### Current problem

Serializing all actions for a component instance is safe but can couple unrelated operations. A slow export-like local action should not necessarily block closing a drawer or changing selection.

### Required correction

Keep the current per-instance serialization as the default, but introduce an explicit concurrency contract:

```ts
export type AgentConcurrency =
  | { mode: "instance" }
  | { mode: "capability" }
  | { mode: "key"; key: string }
  | { mode: "parallel"; max: number };
```

Requirements:

- default remains `{ mode: "instance" }` for safety;
- `parallel` requires an explicit bounded maximum;
- queue depth is configurable per concurrency group;
- procedure references default to a conservative group derived from procedure identity and reference registration;
- concurrency metadata is internal runtime behavior unless there is proven model value in exposing it.

Do not add this API before the base queue implementation and race tests are correct. It is a hardening step, not a prerequisite for the first vertical slice.

---

## 3.6 Choose confirmation mode defaults by topology

### Required behavior

- Embedded/local loop: default may be `wait`.
- Remote/server-side streaming loop: default should be `two-phase` unless the adapter explicitly opts into holding the run open.
- Adapters must declare their topology or confirmation mode; no ambiguous global default.
- Pending confirmations must survive only as long as the registry/session contract permits.
- Adapter shutdown must deterministically settle or expire pending waits.

Add documentation showing transport timeout implications and recovery after reconnect.

---

## 4. Convert the specification into an executable contract

Before broad feature work, create a traceability system.

## 4.1 Assign requirement IDs

Every normative MUST/MUST NOT and every closed decision needs a stable ID, for example:

```text
AS-IDENT-001
AS-LIFE-004
AS-INVOKE-012
AS-POLICY-007
AS-CONFIRM-009
AS-REACT-006
AS-ADAPTER-005
```

Do not renumber IDs after publication. Deprecated requirements remain documented with status.

## 4.2 Add a conformance manifest

Create a machine-readable file such as:

```text
spec/conformance.json
```

Example:

```json
{
  "AS-INVOKE-012": {
    "source": "02-architecture.md#invocation-pipeline-normative-order",
    "tests": [
      "packages/core/test/invoke/pipeline-order.test.ts"
    ],
    "status": "implemented"
  }
}
```

CI must fail when:

- a normative requirement has no test or explicit non-test justification;
- a test points to an unknown requirement;
- a Stable requirement is marked unimplemented;
- a normative behavior changes without a decision-log or migration entry.

## 4.3 Define precedence

Use this precedence when documents disagree:

1. accepted decision record;
2. concepts and security invariants;
3. architecture pipeline;
4. public API specification;
5. error model;
6. adapter and integration documents;
7. examples;
8. implementation plan.

A conflict must be fixed in documentation and tests in the same PR. Never let tests silently become a different spec.

## 4.4 Create an executable error matrix

For every error code, encode:

- exact production phase;
- retry category;
- safe details schema;
- cacheability;
- audit fields;
- adapter obligations;
- at least one positive and one negative test.

The closed error enum and matrix must be generated or cross-validated from one source to prevent drift.

---

## 5. Implementation strategy: prove the thesis before building the platform

Do not implement the entire roadmap in one pass. Deliver vertical slices that are independently useful.

## Phase A — Spec repair and contract harness

### Deliverables

- P0 corrections in Section 3 accepted and reflected across docs.
- Requirement IDs and conformance manifest.
- Error matrix.
- Repository scaffold, CI, strict TypeScript, linting, formatting, build, package validation.
- `@agent-surface/testing` minimal harness created early.

### Exit criteria

- No known normative contradiction in the invocation path.
- Every P0 behavior has an executable failing test or a compile-time fixture before implementation.
- CI runs from a clean clone.

## Phase B — Presentation-plane vertical slice

Implement only what is necessary to prove:

```text
register → snapshot → invoke → state changes → snapshot refresh → unregister
```

### Include

- IDs and definitions.
- `AgentSchema` abstraction.
- Registry lifecycle.
- Observation and action definitions.
- Availability and staleness.
- Basic typed errors.
- Direct toolset.
- `AgentSurfaceProvider` and `useAgentComponent`.
- Testing harness and semantic snapshot.

### Exclude temporarily

- oRPC package.
- WebMCP.
- meta-tools.
- deep binding.
- cross-tab.
- granular React hooks.
- generic policy catalog beyond the minimum needed for the slice.

### Required real workflow

Implement in a realistic legacy-style page:

1. read current filters;
2. set filters;
3. read visible table state;
4. select rows;
5. open a detail view;
6. navigate to another section.

### Exit criteria

- The workflow is fully tested without an LLM.
- React Strict Mode and route transitions pass.
- A semantic surface snapshot is reviewable and stable.
- Application authors can add one capability with a small, local diff.

## Phase C — Runtime hardening

### Include

- corrected two-stage policy pipeline;
- consumer-scoped conflict-safe dedupe;
- bounded action and observation concurrency;
- timeout and cancellation;
- tombstones;
- confirmation protocol;
- audit sinks;
- full error mapping;
- memory bounds and fake-clock tests.

### Exit criteria

- Every race in the normative test list is reproduced deterministically.
- Fuzz/property tests cover ID grammar, schema subset, canonical JSON, dedupe fingerprints, and event ordering.
- No unbounded runtime collection remains.

## Phase D — React hardening

### Include

- latest-ref handler freshness;
- structural fingerprint re-registration;
- pushed availability;
- Strict Mode symmetry;
- Suspense and interrupted render behavior;
- SSR/RSC inertness;
- HMR-safe lifecycle;
- navigation completion semantics;
- leak detection after repeated mount/unmount cycles.

### Exit criteria

- React 18.2 and supported React 19 versions pass the same conformance suite.
- Tests run with Strict Mode enabled.
- Handler freshness is proven with changing props/state and no re-registration.
- Heap or retained-reference tests show no executable handler retained after unregister.

## Phase E — Domain-plane vertical slice

Implement one contextual mutation only after the presentation plane is stable.

### Required workflow

Use the existing example shape:

```text
filter devices
→ read visible rows
→ select rows
→ expose contextual domain procedure
→ bind selected IDs
→ require confirmation
→ execute through authenticated oRPC client
→ server revalidates
→ UI refreshes
```

### Include

- minimal `OrpcAgentManifest` boundary;
- procedure refs;
- top-level binding only;
- locked-field enforcement;
- effective-input validation;
- confirmation over effective input;
- one executor path;
- server error sanitization.

### Exit criteria

- The same domain operation is not exposed through a second server-side model tool.
- A malicious frontend input cannot bypass server authorization.
- Confirmation bait-and-switch and replay tests pass.
- The manifest source decision is resolved before polishing the package API.

## Phase F — Adapter and ecosystem maturity

### Include

- direct embedded adapter as the reference adapter;
- remote per-turn frontend-tool adapter example;
- explicit confirmation topology;
- start/stop/HMR tests;
- provider wire-name fixtures;
- adapter conformance suite.

### Defer

- WebMCP until the core contract is stable and the browser API is sufficiently concrete.
- MCP bridge until session pairing, origin authentication, confirmation across processes, and tab targeting have an accepted design.

## Phase G — Release maturity

### Include

- real measured bundle sizes;
- benchmarks and regression budgets;
- API extraction and compatibility checks;
- Changesets and migration notes;
- provenance-signed packages;
- security review checklist;
- dependency and license checks;
- support policy;
- canary adoption in a second application or materially different section.

### Exit criteria for 1.0 consideration

- At least two production-representative adopters.
- No unresolved contradiction touching Stable APIs.
- One minor release cycle without incompatible changes to candidate Stable APIs.
- Performance and failure-rate telemetry reviewed.
- Recovery and rollback procedures documented.

---

## 6. Required test architecture

## 6.1 Test layers

Use all of these layers:

1. **Type fixtures** — inference, invalid definitions, bound-field constraints, discriminated result narrowing.
2. **Unit tests** — IDs, schemas, canonicalization, policies, caches, queues.
3. **State-machine tests** — registration, invocation, confirmation, dedupe, cancellation.
4. **Property tests** — arbitrary event sequences and input structures.
5. **React integration tests** — lifecycle and handler freshness.
6. **Adapter contract tests** — transport mappings and refresh behavior.
7. **Example application tests** — end-to-end without an LLM.
8. **Optional model evals** — planning quality only, never protocol correctness.

## 6.2 Mandatory state-machine models

Model at least:

### Registration

```text
pending → active → unregistered
        ↘ rejected
```

Assert invalid transitions, idempotent cleanup, tombstone creation, and reference release.

### Invocation

```text
created
→ resolving
→ authorized
→ input-ready
→ awaiting-confirmation | queued | executing
→ settled
```

Every terminal state must release timers, queue slots, listeners, and abort resources.

### Confirmation

```text
pending → approved → consumed
       ↘ denied
       ↘ expired
```

No transition may return to pending or permit a second consume.

## 6.3 Race tests that must exist by name

- `unmount-before-execute`
- `unmount-during-execute-handler-wins`
- `unmount-during-execute-unmount-wins`
- `timeout-with-late-resolution`
- `external-cancel-before-queue-entry`
- `external-cancel-while-queued`
- `duplicate-call-joins-inflight`
- `invocation-id-conflict-fails-closed`
- `confirmation-approved-input-changed`
- `surface-version-changes-before-destructive-call`
- `navigation-commit-then-owner-unmount`
- `listener-mutates-registry-without-reentrant-dispatch`
- `strict-mode-register-cleanup-register`
- `binding-throws-before-confirmation`

## 6.4 Property-based targets

- Canonical ID parser/formatter round-trips.
- Wire-name codec round-trips within provider limits.
- Canonical JSON digest is stable under object insertion order.
- Supported schema subset accepts only documented keywords and depth/size limits.
- Arbitrary register/update/unregister sequences preserve unique live identities.
- Arbitrary event listener behavior never breaks total mutation order.
- Dedupe cache never executes more than once for matching keys/fingerprints.
- No confirmation evidence validates for a non-identical request digest.

---

## 7. Production-readiness requirements

## 7.1 Observability

Emit structured events with a shared correlation model:

```ts
{
  surfaceId,
  surfaceVersion,
  consumerKey,
  invocationId,
  registrationId,
  capabilityId,
  phase,
  outcome,
  durationMs,
}
```

Requirements:

- no raw sensitive input in metadata-level audit;
- configurable redaction for full audit;
- late settlement after timeout/unmount is logged;
- queue wait and execution duration are distinct;
- confirmation wait duration is distinct;
- adapter refresh lag can be measured;
- event sinks cannot crash or block the registry indefinitely.

## 7.2 Performance budgets

Replace estimates with benchmarks. Measure at least:

- registry creation;
- registration and unregistration at 10, 100, and 1,000 components;
- snapshot creation with available, unavailable, hidden, and procedure entries;
- descriptor cache hit/miss;
- invocation overhead excluding handler work;
- policy-chain overhead;
- canonical digest cost at input-size limits;
- React mount/unmount overhead;
- bundle minified and gzip sizes.

Set CI regression thresholds after collecting stable baselines. Do not claim “no measurable frame impact” without a reproducible browser benchmark.

## 7.3 Memory bounds

Every collection needs:

- maximum size;
- TTL if time-sensitive;
- eviction rule;
- disposal behavior;
- fake-clock test;
- metric or audit signal when evictions occur.

This includes:

- dedupe records;
- tombstones;
- pending confirmations;
- action queues;
- observation queues;
- event buffers;
- descriptor caches;
- adapter wire-name maps.

## 7.4 Compatibility matrices

CI should cover:

- Node versions declared by package policy;
- current TypeScript and `typescript@next` as advisory initially;
- React 18.2 and supported React 19 releases;
- Strict Mode;
- Vitest and Jest matchers where promised;
- at least Zod and Valibot through Standard Schema;
- ESM import behavior;
- bundler smoke tests for Vite and one additional common bundler;
- browser-level smoke tests for current Chromium, Firefox, and WebKit when browser APIs are involved.

Do not let `typescript@next` block releases for upstream regressions without triage; classify it as allowed-to-fail only with an open issue and expiry date.

## 7.5 Security review gates

Before each release, verify:

- no automatic exposure path exists;
- `internal` metadata cannot reach snapshots, errors, confirmations, or model tools;
- hidden authority failures are indistinguishable from nonexistence to the consumer;
- domain procedures are still server-authorized;
- confirmation is exact-input, single-use, consumer-bound, registration-bound, and TTL-bound;
- error sanitization does not leak stack, cause, permission names, or raw sensitive values;
- malicious same-realm JavaScript remains explicitly out of scope and is not misrepresented as contained;
- third-party registrants are labeled and guardable;
- adapter implementations cannot omit staleness tokens for destructive calls without a visible failure in conformance tests.

---

## 8. API quality rules

## 8.1 Prefer boring public APIs

Public APIs must be:

- explicit;
- small;
- serializable at boundaries;
- independently testable;
- free of provider/framework leakage;
- difficult to misuse silently.

Reject convenience APIs that:

- infer authority from descriptions;
- mutate registration structure invisibly;
- auto-expose components;
- hide lifecycle or identity;
- accept unvalidated callbacks in security-sensitive phases;
- make remote and local confirmation behavior ambiguous.

## 8.2 Separate stable contracts from sugar

The registry, definitions, invocation result, policy phases, confirmation evidence, and error model are contracts.

Builder functions, schema-library helpers, granular hooks, and adapter conveniences are sugar. Keep sugar Experimental until the underlying contract has production evidence.

## 8.3 Public type compatibility

- Use API Extractor or an equivalent checked API report.
- Review public type diffs in every PR.
- Add `tsd`-style fixtures for intended inference.
- Treat changes in inference, required generics, discriminants, and schema compatibility as API changes even when emitted JavaScript is unchanged.

## 8.4 No undocumented fallback behavior

If malformed host code, adapter behavior, or runtime state triggers a fallback, specify:

- whether it throws, rejects registration, hides, disables, returns a typed error, or logs;
- development versus production behavior;
- audit behavior;
- whether retry is safe.

“Warn and continue” is not a sufficient contract.

---

## 9. Documentation maturity requirements

## 9.1 Maintain three reader paths

Keep distinct paths for:

1. application authors;
2. adapter authors;
3. library implementers/security reviewers.

Do not make application authors read the full core reference to expose a filter action.

## 9.2 Add compact authoritative guides

Before public adoption, provide:

- “First capability in 15 minutes.”
- “Choosing `view:` vs `domain:`.”
- “Safe observations and data minimization.”
- “Confirmation and destructive operations.”
- “Legacy React migration pattern.”
- “Writing a conformant adapter.”
- “Debugging stale and unmounted capabilities.”
- “Versioning and migration policy.”

## 9.3 Keep examples executable

Every code example that claims to be current should be compiled or imported from tested source. Avoid manually duplicated snippets that can drift.

The devices example must remain the behavioral acceptance artifact, but add a smaller presentation-only example for first-time users.

## 9.4 Record limitations honestly

Keep an explicit limitations section covering:

- no same-realm isolation;
- bounded idempotency window;
- cooperative cancellation only;
- no autonomous server-agent contextual gating in 0.x;
- no automatic relevance ranking guarantee;
- no cross-tab semantics;
- schema subset limitations;
- third-party transport/API drift.

---

## 10. Pull-request operating procedure for the coding agent

For every non-trivial PR:

1. state which requirement IDs and decision records are affected;
2. add or update tests before implementation where feasible;
3. update normative docs in the same PR;
4. include public type diff;
5. include bundle/performance impact for hot paths;
6. include security impact for discovery, invocation, confirmation, or adapter changes;
7. include migration guidance for breaking Draft APIs;
8. run the full conformance matrix;
9. update the completeness review with remaining uncertainty;
10. avoid unrelated refactors that obscure protocol changes.

A PR must not be merged when:

- behavior was invented without a decision entry;
- a new error path uses a generic exception at the agent boundary;
- an adapter weakens staleness, consumer identity, confirmation, or error details;
- a normative requirement lacks a test or written non-test rationale;
- a new collection is unbounded;
- implementation and docs disagree;
- an Experimental integration forces a concession in `core`.

---

## 11. Release gates

## Gate 0 — Design coherent

- P0 issues resolved.
- No known normative contradictions.
- Conformance manifest exists.

## Gate 1 — Internal alpha

- Presentation-plane vertical slice works in the legacy dashboard.
- Deterministic tests pass under React Strict Mode.
- No domain mutation yet required.

## Gate 2 — Internal beta

- Confirmation, dedupe, cancellation, queues, audit, and contextual domain mutation work end to end.
- Security review complete.
- Runtime metrics available.

## Gate 3 — Package beta

- API report checked.
- Release tooling and migration notes operational.
- At least one second adoption context validates generality.
- Adapter conformance suite published.

## Gate 4 — 1.0 candidate

- Stable-candidate APIs survived a release cycle.
- No open issue can change a Stable invariant.
- Real performance budgets established.
- Documentation paths and support policy complete.
- Rollback and incident procedures documented.

---

## 12. Explicitly deferred work

Do not spend core-roadmap capacity on these before the release gates justify them:

- WebMCP stabilization work beyond an isolated adapter experiment;
- automatic direct/meta tool switching;
- cross-tab federation;
- MCP bridge;
- deep binding paths;
- binary payloads;
- streaming observations;
- automatic relevance ranking;
- Vue/Svelte/Solid adapters;
- generative UI;
- workflow orchestration;
- general browser automation fallback;
- enterprise authorization language;
- chat rendering or conversation memory.

A real adopter may justify promotion. Architectural curiosity does not.

---

## 13. Final definition of done

The maintainer may call the project **10/10** only when all statements below are true.

### Design

- [ ] The invocation pipeline has no policy/input/confirmation contradiction.
- [ ] Dedupe is consumer-scoped and request-conflict-safe.
- [ ] Navigation success is deterministic across owner unmount.
- [ ] Every concurrency path is bounded and documented.
- [ ] `view:` and `domain:` operations cannot be duplicated accidentally.
- [ ] Confirmation binds to validated effective input.
- [ ] Adapter contracts preserve identity, staleness, policy, effects, and errors.
- [ ] The error model is closed, actionable, safe, and phase-consistent.

### Implementation

- [ ] Every normative requirement maps to implementation and tests.
- [ ] All race tests pass under deterministic clocks.
- [ ] React lifecycle tests pass across the support matrix.
- [ ] No executable references survive unregister/dispose.
- [ ] Every runtime collection has size and lifetime bounds.
- [ ] Property tests cover identity, canonicalization, schemas, event ordering, and dedupe.

### Security

- [ ] The frontend is never represented as authoritative for domain effects.
- [ ] Hidden capabilities do not leak existence.
- [ ] Confirmation replay and bait-and-switch are impossible within the stated threat model.
- [ ] Sensitive metadata and raw errors never cross the agent boundary.
- [ ] Server enforcement is proven in the domain example.

### Maturity

- [ ] Presentation and domain vertical slices run in a production-representative app.
- [ ] Performance budgets are measured and enforced.
- [ ] Public API compatibility is checked automatically.
- [ ] Release, migration, support, and incident procedures exist.
- [ ] At least two adoption contexts validate the abstraction.
- [ ] Stable-candidate APIs survived one release cycle without incompatible change.

---

## 14. Immediate next actions

Execute these in order:

1. Open a **Spec Correction RFC** covering pipeline order, policy phases, effective-input confirmation, invocation identity, and navigation semantics.
2. Patch `02`, `03`, `05`, `06`, `07`, `08`, `09`, `13`, `14`, and `15` so they agree.
3. Add failing conformance tests for the corrected protocol before runtime implementation.
4. Implement the smallest presentation-plane vertical slice in a realistic legacy React page.
5. Measure authoring friction, lifecycle churn, catalog size, and invocation overhead.
6. Harden concurrency, dedupe, cancellation, confirmation, and audit.
7. Add one contextual domain mutation through oRPC with server revalidation.
8. Only then generalize adapters, package boundaries, and release tooling.

The project’s advantage is not feature breadth. Its advantage is a precise, explicit, lifecycle-aware control plane that remains trustworthy when models, providers, frameworks, routes, and UI implementations change. Preserve that advantage by proving each layer before expanding the next.
