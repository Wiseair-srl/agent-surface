# 15 — Documentation Completeness Review

> **D40 update:** repository completeness is proven by the compiler-generated production graph contract. The former tsconfig upper bound, scenario denominator, unresolved/undeclared buckets and allowlists are superseded. Runtime snapshots remain projections only.

> [!NOTE]
> Standing self-review: an honest map of what is settled, what is open, where the spec might bite itself, and what must be proven by code before being trusted. First written 2026-07-29 alongside the P0 corrections ([Spec Corrections RFC](18-spec-corrections-rfc.md), following the [maintainer directive](17-maintainer-directive.md)); kept current since — last revised for the surface-coverage work ([Surface Coverage RFC](21-surface-coverage-rfc.md)) at 0.10.

## P0 corrections (resolved, code-proven)

The directive's §3 P0 specification bugs are corrected by RFC 18 (decisions D21–D26) and — unlike the rest of this review's "must be validated" items — each landed **with** its implementation and named conformance tests in the same change: pipeline order (effective input before input-aware policy/confirmation), consumer-scoped conflict-safe invocation identity (`INVOCATION_CONFLICT`), navigation settlement under owner unmount, bounded observation concurrency + bounded pending confirmations, topology-declared confirmation modes. The action-concurrency contract (D25) was the one intentional spec-ahead-of-code item, carried as `specified` in `spec/conformance.json` until **0.2 implemented it** (`AS-CONC-001`, `test/conformance/concurrency-groups.test.ts`). No requirement is `specified` today: all 111 are `implemented`, and the manifest gate is what keeps that true.

## Decisions defined

- Every decision is resolved with its chosen behavior, the alternatives, and the trade-off accepted: the 20 mandated ones (D1–D20), the effect-taxonomy question (D-eff), the six P0 corrections (D21–D26), and the eleven raised since by real hosts and real models (D27–D37 — catalog scale, meta-mode reliability, the developer projections, surface coverage). All are indexed in [Decisions, Part A](13-open-questions.md#part-a--decision-log); the normative text lives in the linked sections.
- Additionally settled beyond the mandate: ID grammar and parsing rule ([Concepts](../01-concepts.md#canonical-id-grammar-draft)); tombstones for `COMPONENT_UNMOUNTED` vs `CAPABILITY_NOT_FOUND`; confirmation evidence binding by deep-equal input match; wire-name codec; procedure descriptors at snapshot top level; error `retry` semantics per code; limits table with concrete defaults; adapter duties checklist; milestone plan with acceptance criteria.

## Decisions still open

Tracked with leanings in [Decisions, Part B](13-open-questions.md#part-b--genuinely-open-questions): OQ-1 orpc-agent manifest contract (**overdue** — it was due before M9, which has shipped); OQ-2 WebMCP drift; OQ-3 cross-tab; OQ-4 relevance/budgets; OQ-5 server-side-agent contextual gating; OQ-6 deep binding paths; OQ-7 i18n; OQ-8 snapshot hints; OQ-9 meta-tools threshold; OQ-10 streaming observations; OQ-11 Zod sugar package; OQ-12 confirmation UX weight for view actions; OQ-13 static extraction of the granular React hooks; OQ-14 whether `undeclared` should fail `coverage`. Only OQ-1 is late; none blocks a release.

## What the tooling still cannot tell you

Added with the surface-coverage work ([Surface Coverage RFC](21-surface-coverage-rfc.md), D35–D37), because a coverage number is exactly the kind of figure that gets over-trusted:

- **A UI affordance that was never registered is undetectable.** No capability, no call site, no registration — nothing for the catalog to read or the verdict to miss. Human review of the diff is the only gate, and this is the class of gap most likely to be assumed covered.
- **The catalog is an upper bound**, not a count of live capabilities: tsconfig include globs are wider than what a bundle reaches, so a component no route renders any more is still in it. Reported as unreached, which is a different finding from a missing scenario, and the developer decides which.
- **The `domain:` plane is not statically analyzed at all** — it comes from the oRPC router (OQ-1). the catalog says `not analyzed` rather than reporting zero, because zero reads as *there are none*.
- **The static catalog is only as good as its own admission of failure.** Every downstream number depends on `AS-COVER-002`/`003` holding: unreadable call sites reported, and `check` exiting non-zero until someone accepts them knowingly.

## Potential inconsistencies (watch these during implementation)

1. **`surfaceVersion` vs lazy `when()`** — the version deliberately does not capture lazy availability drift in non-React usage ([Core API §availability](../03-core-api.md#availability)). Documented as intentional, but adapters must not assume "same version ⇒ same availability". If this confuses adapter authors in practice, promote push-based availability to a core requirement.
2. **`CONFIRMATION_REQUIRED` as error-shaped protocol step** — one wire shape (chosen for a binary result union), but prose must keep saying "not a failure". If embedded-loop DX suffers, a 3-status union is the fallback design (noted in [Core API §invocation](../03-core-api.md#invocation)).
3. **Two-key staleness** (`registrationId` precise, `surfaceVersion` only for destructive/external) is subtle; the risk is adapters sending neither. Mitigated by toolset defaults and the adapter checklist, but it's the most likely spot for implementation drift.
4. **Suffix-collision heuristic** (`view:X.Y` vs `domain:X.Y`) is lint-grade and can false-positive/negative; the spec says so, but readers may over-trust it.
5. **Prompt-sketch divergences, intentional:** procedure references live at snapshot top level (not nested per component); `registry.confirmations` controller replaces a flat `resolveConfirmation` method; capability builders (`action()`/`observation()`) are the recommended authoring form because record-literal inference cannot carry per-entry generics (proven in the prototype).

## Assumptions

- `orpc-agent` can supply (or the app can hand-write) a manifest of exposed procedures with JSON Schemas and effect metadata; the interop is written against the documented API at orpc-agent.dev (`capabilities.capabilities()`, `runtime.describe`, `toAISDKTools`) and quarantined behind `OrpcAgentManifest` (OQ-1 tracks the source choice).
- Embedded loops and server-side loops with per-turn frontend tool transport (the Mastra + assistant-ui topology in [Mastra + assistant-ui](../16-mastra-assistant-ui.md)) are in scope **on paper**: the embedded loop is exercised by `examples/devices-app`, the server-side one only by hand-written snippets — see the executable-example gap below. *Autonomous* server-side agents without a live frontend remain out of contextual-gating scope (OQ-5).
- React ≥18.2 effect semantics (register on commit, cleanup on hide/unmount) hold on 19.x; `Activity`-style hiding runs cleanup.
- JSON-only payloads and the D19 schema subset are sufficient for real capabilities in the target apps.
- TypeScript ≥5.4 (`NoInfer`) is acceptable as a floor.
- Same-realm JS is not containable; trust labels are policy inputs, not sandboxes ([Policies & Security §trust](../06-policies-and-security.md#trust-model-for-registrants)).

## Technical risks

Top items with mitigations in [Implementation plan §risk register](14-implementation-plan.md#risk-register-top-5): React 18↔19 effect-timing drift; D19 subset too narrow; orpc-agent API instability; invocation-pipeline races (D13–D17); oversized catalogs in real apps. Additional spec-level risk: total spec volume — implementers should treat [Testing §recipes](../08-testing.md#recipes-normative-test-list) as the executable contract when prose and tests ever disagree.

## Validated via prototype (already done)

`prototypes/api-typecheck.ts` (tsc `--strict`, clean) + `prototypes/runtime-checks.ts` (executed, passing) confirmed:

- schema→handler inference (`action`/`observation` helpers), input/param typing, result-union narrowing, bind-subset + `overridableFields` constraints (including the intended compile errors);
- schema-inferred alias types satisfy the `JsonValue` constraints (interface caveat documented in [Core API](../03-core-api.md#serialization-rules-d18-draft));
- **finding folded back into the spec:** naive `execute` return inference conflicts with `output` schema inference → `NoInfer` on `execute` is now normative in [Core API §definitions](../03-core-api.md#capability-definitions-and-helpers);
- wire-name codec round-trips and stays in the provider-safe alphabet; confirmation deep-equal matcher behaves per [Policies & Security rule 2](../06-policies-and-security.md#normative-rules).

## Must be validated by the implementation prototype (not yet provable on paper)

1. React commit-phase registration under Strict Mode + Suspense + React 19, especially availability-push ordering vs adapters' re-snapshot (M7).
2. The 10-phase pipeline's remaining race behavior beyond the named suites: the §6.3 race list exists by name (`test/conformance/races.test.ts`), §6.4 property invariants run under fast-check (`test/property/`), and D25 concurrency groups are implemented and covered (`test/conformance/concurrency-groups.test.ts`). What remains for Phase C is higher-cardinality interleaving fuzzing — arbitrary event sequences driving the full pipeline concurrently, including mixed group modes.
3. Schema surgery for partial bindings against real Zod-generated JSON Schemas, including `required` handling and `$defs` (M9).
4. Whether `wait`-mode confirmations feel right in a real embedded loop, and whether models actually follow `retry` hints (M8/M10 scripted-model harness first, then a manual session).
5. Catalog sizes and model behavior in `direct` vs `meta` mode. Partly answered by the first host at scale ([Catalog Scale RFC](19-catalog-scale-rfc.md)): at ~300 capabilities the per-step projection and the prompt-prefix cost are both real and both now addressed (D28–D30), and [Adapters §choosing-a-mode](../09-adapters.md#choosing-a-mode) records the resulting guide. What is still unmeasured is the part that needs a model rather than a benchmark — *selection accuracy* on a flat list of hundreds versus lazy discovery through `surface_discover`. That is what would justify or refute an automatic switch (OQ-9).
6. ~~Bundle-size targets — aspirational until size-limit runs in CI.~~ Measured: size-limit enforces the budgets in CI and first runtime baselines are recorded in [Architecture §budgets](../02-architecture.md#bundle-and-performance-budgets); CI regression *thresholds* for the runtime numbers still need stable CI baselines (directive §7.2).
7. **Executable-example gap (directive §9.3).** `examples/` holds exactly one package, `devices-app` — the behavioral acceptance artifact for the embedded topology ([Examples](../10-examples.md), `AS-EXAMPLE-001`). Two documented things have no executable coverage: the **remote/server-side topology** ([Mastra + assistant-ui](../16-mastra-assistant-ui.md) is a wiring guide whose snippets are hand-written and un-type-checked — they already required a manual patch when D26 landed), and the **presentation-only starter example** §9.3 asks for (today a newcomer's first contact is the full app, oRPC and confirmations included). Until both exist, treat docs/16 as a shape to follow, and expect its code to drift ahead of the packages. Promotion path: extract its bridge files into a type-checked package first, build the Mastra/orpc-agent backend only if a real adopter needs it (that adopter would also satisfy the Gate 3 "second adoption context").
