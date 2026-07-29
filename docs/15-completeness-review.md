# 15 — Documentation Completeness Review

> [!NOTE]
> Self-review of this specification as of its initial authoring (2026-07-29; framework-integration example and orpc-agent alignment added the same day; **P0 corrections applied the same day via [18-spec-corrections-rfc.md](18-spec-corrections-rfc.md)** following the [maintainer directive](17-maintainer-directive.md)). Purpose: give the implementing agent an honest map of what is settled, what is open, where the spec might bite itself, and what must be proven by code before being trusted.

## P0 corrections (resolved, code-proven)

The directive's §3 P0 specification bugs are corrected by RFC 18 (decisions D21–D26) and — unlike the rest of this review's "must be validated" items — each landed **with** its implementation and named conformance tests in the same change: pipeline order (effective input before input-aware policy/confirmation), consumer-scoped conflict-safe invocation identity (`INVOCATION_CONFLICT`), navigation settlement under owner unmount, bounded observation concurrency + bounded pending confirmations, topology-declared confirmation modes. The action-concurrency contract (D25) is *specified, deliberately unimplemented* until Phase C — the one intentional spec-ahead-of-code item, tracked as `specified` in `spec/conformance.json`.

## Decisions defined

- All 20 mandated decisions (D1–D20), the effect-taxonomy question (D-eff), and the six P0-correction decisions (D21–D26) are resolved with recommended v0.1 behavior, alternatives, and trade-offs — indexed in [13 Part A](13-open-questions.md#part-a--decision-log), normative text in the linked sections.
- Additionally settled beyond the mandate: ID grammar and parsing rule ([01](01-concepts.md#canonical-id-grammar-draft)); tombstones for `COMPONENT_UNMOUNTED` vs `CAPABILITY_NOT_FOUND`; confirmation evidence binding by deep-equal input match; wire-name codec; procedure descriptors at snapshot top level; error `retry` semantics per code; limits table with concrete defaults; adapter duties checklist; milestone plan with acceptance criteria.

## Decisions still open

Tracked with leanings in [13 Part B](13-open-questions.md#part-b--genuinely-open-questions): OQ-1 orpc-agent manifest contract (the only one with a deadline — before M9); OQ-2 WebMCP drift; OQ-3 cross-tab; OQ-4 relevance/budgets; OQ-5 server-side-agent contextual gating; OQ-6 deep binding paths; OQ-7 i18n; OQ-8 snapshot hints; OQ-9 meta-tools threshold; OQ-10 streaming observations; OQ-11 Zod sugar package; OQ-12 confirmation UX weight for view actions. None blocks v0.1.

## Potential inconsistencies (watch these during implementation)

1. **`surfaceVersion` vs lazy `when()`** — the version deliberately does not capture lazy availability drift in non-React usage ([03 §availability](03-core-api.md#availability)). Documented as intentional, but adapters must not assume "same version ⇒ same availability". If this confuses adapter authors in practice, promote push-based availability to a core requirement.
2. **`CONFIRMATION_REQUIRED` as error-shaped protocol step** — one wire shape (chosen for a binary result union), but prose must keep saying "not a failure". If embedded-loop DX suffers, a 3-status union is the fallback design (noted in [03 §invocation](03-core-api.md#invocation)).
3. **Two-key staleness** (`registrationId` precise, `surfaceVersion` only for destructive/external) is subtle; the risk is adapters sending neither. Mitigated by toolset defaults and the adapter checklist, but it's the most likely spot for implementation drift.
4. **Suffix-collision heuristic** (`view:X.Y` vs `domain:X.Y`) is lint-grade and can false-positive/negative; the spec says so, but readers may over-trust it.
5. **Prompt-sketch divergences, intentional:** procedure references live at snapshot top level (not nested per component); `registry.confirmations` controller replaces a flat `resolveConfirmation` method; capability builders (`action()`/`observation()`) are the recommended authoring form because record-literal inference cannot carry per-entry generics (proven in the prototype).

## Assumptions

- `orpc-agent` can supply (or the app can hand-write) a manifest of exposed procedures with JSON Schemas and effect metadata; the interop is written against the documented API at orpc-agent.dev (`capabilities.capabilities()`, `runtime.describe`, `toAISDKTools`) and quarantined behind `OrpcAgentManifest` (OQ-1 tracks the source choice).
- Embedded loops and server-side loops with per-turn frontend tool transport (the Mastra + assistant-ui topology in [16](16-mastra-assistant-ui.md)) are in scope **on paper**: the embedded loop is exercised by `examples/devices-app`, the server-side one only by hand-written snippets — see the executable-example gap below. *Autonomous* server-side agents without a live frontend remain out of contextual-gating scope (OQ-5).
- React ≥18.2 effect semantics (register on commit, cleanup on hide/unmount) hold on 19.x; `Activity`-style hiding runs cleanup.
- JSON-only payloads and the D19 schema subset are sufficient for real capabilities in the target apps.
- TypeScript ≥5.4 (`NoInfer`) is acceptable as a floor.
- Same-realm JS is not containable; trust labels are policy inputs, not sandboxes ([06 §trust](06-policies-and-security.md#trust-model-for-registrants)).

## Technical risks

Top items with mitigations in [14 §risk register](14-implementation-plan.md#risk-register-top-5): React 18↔19 effect-timing drift; D19 subset too narrow; orpc-agent API instability; invocation-pipeline races (D13–D17); oversized catalogs in real apps. Additional spec-level risk: total spec volume — implementers should treat [08's recipe list](08-testing.md#recipes-normative-test-list) as the executable contract when prose and tests ever disagree.

## Validated via prototype (already done)

`prototypes/api-typecheck.ts` (tsc `--strict`, clean) + `prototypes/runtime-checks.ts` (executed, passing) confirmed:

- schema→handler inference (`action`/`observation` helpers), input/param typing, result-union narrowing, bind-subset + `overridableFields` constraints (including the intended compile errors);
- schema-inferred alias types satisfy the `JsonValue` constraints (interface caveat documented in [03](03-core-api.md#serialization-rules-d18-draft));
- **finding folded back into the spec:** naive `execute` return inference conflicts with `output` schema inference → `NoInfer` on `execute` is now normative in [03 §definitions](03-core-api.md#capability-definitions-and-helpers);
- wire-name codec round-trips and stays in the provider-safe alphabet; confirmation deep-equal matcher behaves per [06 rule 2](06-policies-and-security.md#normative-rules).

## Must be validated by the implementation prototype (not yet provable on paper)

1. React commit-phase registration under Strict Mode + Suspense + React 19, especially availability-push ordering vs adapters' re-snapshot (M7).
2. The 10-phase pipeline's remaining race behavior beyond the named suites: the §6.3 race list exists by name (`test/conformance/races.test.ts`) and §6.4 property invariants run under fast-check (`test/property/`); what remains for Phase C is higher-cardinality interleaving fuzzing (arbitrary event sequences driving the full pipeline concurrently) and the D25 concurrency-group implementation.
3. Schema surgery for partial bindings against real Zod-generated JSON Schemas, including `required` handling and `$defs` (M9).
4. Whether `wait`-mode confirmations feel right in a real embedded loop, and whether models actually follow `retry` hints (M8/M10 scripted-model harness first, then a manual session).
5. Catalog sizes and model behavior in `direct` vs `meta` mode on a page with tens of capabilities (v0.3 measurements, OQ-4/OQ-9).
6. ~~Bundle-size targets — aspirational until size-limit runs in CI.~~ Measured: size-limit enforces the budgets in CI and first runtime baselines are recorded in [02 §budgets](02-architecture.md#bundle-and-performance-budgets-first-measured-baselines); CI regression *thresholds* for the runtime numbers still need stable CI baselines (directive §7.2).
7. **Executable-example gap (directive §9.3).** `examples/` holds exactly one package, `devices-app` — the behavioral acceptance artifact for the embedded topology ([10](10-examples.md), `AS-EXAMPLE-001`). Two documented things have no executable coverage: the **remote/server-side topology** ([16](16-mastra-assistant-ui.md) is a wiring guide whose snippets are hand-written and un-type-checked — they already required a manual patch when D26 landed), and the **presentation-only starter example** §9.3 asks for (today a newcomer's first contact is the full app, oRPC and confirmations included). Until both exist, treat docs/16 as a shape to follow, and expect its code to drift ahead of the packages. Promotion path: extract its bridge files into a type-checked package first, build the Mastra/orpc-agent backend only if a real adopter needs it (that adopter would also satisfy the Gate 3 "second adoption context").
