# 14 — Implementation Plan

> [!NOTE]
> **Status: Draft.** Turns this spec into ordered, verifiable milestones. Each milestone lists scope, expected files, included APIs, required tests, acceptance criteria, dependencies, and top risks. A milestone is *done* only when its acceptance tests pass and the docs it implements needed no undocumented decisions — if an implementer had to invent behavior, that's a spec bug to fix in the same PR.

## Sequencing rationale

The originally proposed progression (domain model → registry → lifecycle → snapshot → invocation → policies → React → testing → oRPC → example → WebMCP) is sound but improved in three ways:

1. **The core test harness moves before React** (M2, not after it). The harness is the reference consumer; building registry features test-first against `createTestSurface` keeps seams honest and makes every subsequent milestone self-verifying. The *React* half of the testing package still lands after React (M7).
2. **Confirmation is folded into the policy milestone** (M6) rather than floating: it is a policy outcome plus a store, and testing it needs the pipeline.
3. **The example app is built alongside the oRPC adapter** (M9–M10 overlap), because [10-examples.md](10-examples.md) is the acceptance artifact for both.

Milestones are strictly ordered by dependency; within one milestone, tasks parallelize freely.

---

### M0 — Repo scaffold

- **Scope:** pnpm workspace; packages `core`, `react`, `orpc`, `testing`, `webmcp` (stub), `examples/devices-app` (stub); tsup builds (ESM + d.ts), vitest, TypeScript strict, publint + size-limit + Changesets; CI matrix (React 18/19, TS current/next).
- **Files:** `pnpm-workspace.yaml`, per-package `package.json`/`tsconfig`, root vitest config, `.github/workflows/ci.yml`.
- **Tests:** CI runs an empty suite green; size-limit wired.
- **Acceptance:** `pnpm build && pnpm test` green on a clean clone.
- **Risks:** none meaningful.

### M1 — Identity, schema layer, definition model

- **Scope:** id grammar + parse/format/validate + wire codec; `AgentSchema`, `fromStandardSchema`, `fromJsonSchema` + subset validator (D19); `JsonValue` guards; definition types; `action`/`observation`/`defineAgentComponent` helpers; definition validation (caps, plane rule, duplicate capability names); `AgentSurfaceDefinitionError`.
- **Files:** `core/src/{ids,schema,definition,errors}.ts`.
- **APIs:** [03 §schemas](03-core-api.md#schemas), [§definitions](03-core-api.md#definitions); [07 §registration-time](07-errors.md#registration-time-errors).
- **Tests:** grammar accept/reject table; wire codec round-trip + overflow hashing; subset validator vs a fixture corpus (accepted + rejected schemas); Zod 4 + Valibot through Standard Schema; every `AgentSurfaceDefinitionError` code reachable.
- **Acceptance:** `prototypes/api-typecheck.ts` compiles against the real types unchanged (inference parity with the spec's examples).
- **Depends:** M0. **Risks:** subset validator correctness — mitigate with fixture corpus reused by testing pkg.

### M2 — Registry core + test harness (framework-free)

- **Scope:** `createAgentSurfaceRegistry`; registration/unregistration; handles (`update`, `invalidate`, dead handles); collision handling (D4); availability computation; `surfaceId`/`surfaceVersion` (D1/D2); event dispatcher with D17 guarantees; injectable clock; **`createTestSurface`** with `events()`, `snapshot()` (minimal), `as()`.
- **Files:** `core/src/{registry,events}.ts`; `testing/src/harness.ts`.
- **Tests:** lifecycle register→unregister; Strict-Mode-like double register/unregister symmetry; collision reject/replace; version bump matrix (what bumps, what doesn't); event ordering incl. re-entrancy and throwing listeners.
- **Acceptance:** every guarantee sentence in [02 §guarantees](02-architecture.md#concurrency-and-ordering-guarantees) has a named test.
- **Depends:** M1. **Risks:** re-entrancy semantics — encode the spec examples as tests first.

### M3 — Snapshot projection

- **Scope:** descriptor projection (frozen JSON, `internal` stripped), deterministic ordering, `scope`/`includeUnavailable` filters, budget + `truncated` (Experimental flag), route info, per-registration descriptor caching.
- **Files:** `core/src/snapshot.ts`.
- **Tests:** snapshot purity (no `read()` calls — spy); `internal` never serialized (deep scan); ordering stability across mount orders; budget drop order by priority.
- **Acceptance:** semantic-snapshot fixture of a synthetic surface matches [03 §snapshot](03-core-api.md#snapshot) shapes field-for-field.
- **Depends:** M2. **Risks:** low.

### M4 — Invocation pipeline + error model

- **Scope:** the 9-phase pipeline ([02](02-architecture.md#invocation-pipeline-normative-order)) minus policy phase (stub pass-through); resolution incl. tombstones, `AMBIGUOUS_INSTANCE`, staleness rules (D1); input parse; preconditions; concurrency (D13), dedupe (D14), timeout/cancel (D15), unmount-mid-flight (D16); result envelopes; full `AgentCapabilityErrorPayload` serialization + sanitization.
- **Files:** `core/src/{invoke,errors}.ts` (+ harness `invoke/observe/captureRef`).
- **Tests:** one suite per error code reproducing its [07](07-errors.md) "produced when" conditions; dedupe join + terminal-cache exclusions; fake-timer timeout with late-settlement audit; abort propagation; stale matrix (replaced / reloaded / version-mismatch-on-destructive).
- **Acceptance:** [08 recipes](08-testing.md#recipes-normative-test-list) that don't involve React/policies/confirmation all pass.
- **Depends:** M3. **Risks:** the largest milestone — split into resolution/execution/dedupe PRs; race tests are the deliverable, not an afterthought.

### M5 — Policy pipeline

- **Scope:** `AgentPolicy`, chain composition (registry→component→capability), sync `onDiscovery` in snapshot + re-check at invoke, async `onInvoke` onion; built-ins: `authenticated`, `hasPermission`, `tenantBoundary`, `environment`, `rateLimit`, `audit`; hide-vs-disable semantics (D11/D12).
- **Files:** `core/src/policy.ts`.
- **Tests:** most-restrictive-wins; discovery/invocation consistency (hidden ⇒ NOT_FOUND, disabled ⇒ NOT_AVAILABLE); per-consumer filtering (requirement 12); each built-in.
- **Acceptance:** requirement-by-requirement checklist of [06 §mapped](06-policies-and-security.md#the-deny-by-default-requirements-mapped) items 1–12 (minus confirmation, next).
- **Depends:** M4.

### M6 — Confirmation + audit sinks

- **Scope:** pending store, evidence lifecycle (bind/approve/deny/expire/consume, deep-equal input match), `ConfirmationController`, `requireConfirmation` policy, TTL via injectable clock; `AuditSink` + memory/console sinks; audit levels + redaction hook; harness `confirmations.{approve,deny,expire}`.
- **Files:** `core/src/{confirmation,audit}.ts`.
- **Tests:** the full [06 §rules](06-policies-and-security.md#normative-rules) list — replay, mismatch (bait-and-switch), expiry, denial no-retry, staleness-beats-confirmation, pending re-request returns same id; audit event completeness.
- **Acceptance:** confirmation recipes in [08](08-testing.md) pass verbatim.
- **Depends:** M5.

### M7 — React package + React testing

- **Scope:** `AgentSurfaceProvider`, `useAgentSurface`, `useAgentComponent` (commit-phase registration, identity keys, structural-fingerprint re-register, latest-ref handlers, availability push), `usePendingConfirmations`; Experimental `AgentComponentScope`/`useAgentAction`/`useAgentObservation`; `renderAgentSurface` + matchers + semantic snapshots.
- **Files:** `react/src/*`; `testing/src/{react,matchers,serialize}.ts`.
- **Tests:** Strict Mode symmetry; Suspense (register only after commit); identity-change re-register; handler freshness (state captured at invoke time); availability push on `when` flip; instance lists with entity ids; portal indifference; unmount-mid-invoke through real React; matcher semantics incl. hidden-vs-disabled; snapshot normalization (`<reg#N>`).
- **Acceptance:** all React-flavored [08 recipes](08-testing.md#recipes-normative-test-list) pass under React 18 + 19, Strict Mode on.
- **Depends:** M4 (invoke), M6 (confirmations) for full surface; can start on M2.
- **Risks:** highest subtlety — React 19 effect timing; mitigate by porting the exact semantics tests to both React majors from day one.

### M8 — Embedded toolset adapter

- **Scope:** `createAgentToolset` (direct mode), description templating (plane/effect prefixes), wire naming + per-version map, `wait`/`two-phase` confirmation modes, `subscribe` on version change, tool-call-id → invocationId.
- **Files:** `core/src/toolset.ts`.
- **Tests:** catalog refresh on version bump; wait-mode single-call confirmation round-trip (fake timers); two-phase relay; dedupe via toolCallId; wire-name overflow.
- **Acceptance:** a scripted fake "model" (list tools → call → handle error → retry per `retry` hints) completes the devices scenario against a synthetic registry — no LLM.
- **Depends:** M6. — *v0.1 ships here.*

### M9 — oRPC package

- **Scope:** `createOrpcAgentBridge`, manifest contract (OQ-1 escape hatch included), refs typing from router client, `bindAgentProcedure`/`useAgentProcedure`, binding semantics D7/D8 (schema surgery, locking, execution-time `bind`, full-schema re-parse), executor + `callContext`, exposure gating, suffix-collision feed, `AMBIGUOUS_INSTANCE` for multi-reference.
- **Files:** `orpc/src/{bridge,binding,executor}.ts`, `orpc/react.ts`.
- **Tests:** schema-surgery matrix (partial/all/none bound, required handling); locked override → INVALID_INPUT; overridable default behavior; binding throw → PRECONDITION_FAILED(binding-failed); manifest-absent ref registers nothing; executor receives merged validated input; server-error mapping incl. server-origin CONFIRMATION_REQUIRED.
- **Acceptance:** oRPC recipes in [08](08-testing.md) + type-level tests (bind subset compile errors) pass.
- **Depends:** M8. **Risks:** orpc-agent API drift (OQ-1) — isolate behind the manifest type; only the bridge factory touches real orpc-agent.

### M10 — Example application

- **Scope:** `examples/devices-app`: the full [10-examples.md](10-examples.md) page (filters, table, drawer, disable flow, confirmation host, navigation component, two-instance page), mock oRPC backend, embedded fake-agent dev panel (scripted, optional real provider behind an env var — never in CI), the complete test suite from 08/10.
- **Acceptance:** the 11-step scenario runs scripted end-to-end in CI (no LLM); every [08 recipe](08-testing.md#recipes-normative-test-list) exists here at least once; semantic surface snapshot committed and reviewed.
- **Depends:** M9. **Risks:** none technical; this milestone exists to force spec honesty.

### M11 — WebMCP adapter (Experimental)

- **Scope:** `@agent-surface/webmcp` per [09 §webmcp](09-adapters.md#webmcp-adapter-experimental): feature-detect, register/refresh on version change, wire naming, curation hook, two-phase confirmations.
- **Tests:** against a `navigator.modelContext` mock (the spec being unstable, the mock encodes our assumptions and is updated deliberately).
- **Acceptance:** devices example exposes its surface through the mock; unavailable capabilities absent; drift risk documented in the package README.
- **Depends:** M8 (M10 useful, not required).

---

## Cross-cutting definition of done (every milestone)

- No public API without spec text; no spec text contradicted by code (doc PRs ride along).
- Every typed error the milestone introduces is produced by at least one test.
- `environment: "development"` diagnostics tested (they are API too).
- Size-limit budgets updated consciously, never silently.

## Risk register (top 5)

| Risk | Impact | Mitigation |
|---|---|---|
| React effect-timing semantics differ 18↔19 | wrong lifecycle = broken staleness story | dual-major CI from M7 day one; semantics tests, not implementation tests |
| JSON Schema subset too narrow for real apps | authors blocked at registration | fixture corpus grown from example app; D19 marked revisitable |
| orpc-agent API instability | M9 rework | manifest indirection (OQ-1); hand-written manifest path always works |
| Invocation pipeline race conditions | corrupted guarantees | M4 test-first on D13–D17; injectable clock; race tests in CI |
| Surface catalogs too big for model context in real apps | poor agent behavior | budgets + scoping shipped early (M3), meta-tools measured in v0.3 (OQ-4/OQ-9) |
