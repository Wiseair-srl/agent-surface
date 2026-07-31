# 12 — Roadmap

> [!NOTE]
> **Status:** planning document, not a commitment. Versions are pre-1.0: minor versions may break APIs labeled Draft, and WILL break APIs labeled Experimental. Every release documents breaking changes; the spec in `docs/` is updated in the same PR as the code that changes behavior.

## Version plan

> [!NOTE]
> **Re-cut after 0.1.0.** The original plan staged the packages across v0.1/v0.2/v0.3; 0.1.0 actually shipped all five (`core`, `react`, `orpc`, `testing`, `webmcp`) plus the example app, meta-tools mode, and budgets. Feature staging is therefore no longer the useful axis. What is left is *maturity*: the gap between "implemented" and "proven, enforced, and adopted twice" ([17 §11 release gates](17-maintainer-directive.md)).

### v0.1 — shipped (2026-07-30)

All five packages, the `devices-app` example as the behavioral acceptance artifact, the conformance manifest with named tests, and the P0 protocol corrections D21–D26.

Known gaps at 0.1.0, all now closed or scheduled below: D25 concurrency groups were specified but unimplemented; meta-tools mode diverged from the direct-mode contract; CI ran a single Node/React combination.

### v0.2 — trust — shipped (2026-07-31)

No new surface area. Everything here closed a gap between what the docs promised and what CI proved:

- **Meta-tools parity** (`AS-ADAPTER-004/005`, D27): identical resolution to direct mode, adapter scope as a floor, meta-only budgets.
- **D25 concurrency groups** (`AS-CONC-001`): the last requirement that was `specified` rather than `implemented` — the manifest reached 77/77.
- **Support matrix**: Node 20.19/22 × React 18.2/19, out-of-workspace ESM import, Vite bundle smoke, advisory `typescript@next`, Valibot alongside Zod through Standard Schema.

### v0.3 — catalog scale — shipped (2026-07-31)

The first correction cycle driven by a host rather than by self-review: a dashboard at ~300 domain capabilities and 40+ mounted view capabilities per route ([19](19-catalog-scale-rfc.md), D28–D30). Manifest 77 → 90/90.

- **Capability state is data, not description text** (`AS-CACHE-001…004`, D28). Tool definitions are the provider's cached prompt prefix; folding `available` into the description re-billed the conversation on every click. `AgentTool.state` and `AgentProcedureDescriptor.contextualNote`, behind compatibility flags intended to last one minor — removed in [v0.5](#v05--the-split-is-the-only-composition--shipped-2026-07-31) without ever flipping.
- **`mode:"meta"` graduated to supported** (`AS-META-001…005`, D29) on a suite pinning what makes it different. An Experimental marker on the library's only answer for an oversized catalog made it unreachable exactly where it was needed. *(Reversed in [v0.7](#v07--meta-is-experimental-again--shipped-2026-07-31): the suite covered the mode's distinguishing behaviors, not its verb envelope, which is where 0.6 then found two defects.)*
- **Wire names fit the provider budget and keep their identity** (`AS-WIRE-004…007`, D30): collision-checked per emitted catalog, reversed through `wireNameMap()`, and `decodeWireName` now refuses rather than returning a plausible wrong id.

Breaking, as a 0.x minor may be ([stability policy](#stability-policy)): `AgentTool.state` is required for anyone *constructing* a tool, and wire names can no longer be reversed by string surgery.

### v0.4 — discovery honesty — shipped (2026-07-31)

One decision, cut on its own rather than held for the D28 default flip that this slot was reserved for — see the schedule note below.

- **Discovery says what it withheld** (`AS-META-006`, D31): `surface_discover` marks a scope the configured floor refused, so an empty payload is no longer indistinguishable from an empty surface, and the three meta verbs describe their parameters. Manifest 90 → 91/91.
- `core`'s size budget was deliberately revised 18 → 19 kB (measured 18.33 kB) — the parameter descriptions are the change, so the bytes are payload the model reads ([02 §budgets](02-architecture.md#bundle-and-performance-budgets-first-measured-baselines)).

> [!NOTE]
> **The D28 compatibility flags did not flip here.** They were removed outright in [v0.5](#v05--the-split-is-the-only-composition--shipped-2026-07-31) instead — the schedule had already slipped twice and the deferred migration was buying nothing pre-1.0.

### v0.5 — the split is the only composition — shipped (2026-07-31)

The D28 migration ended by deletion rather than by the planned flip-then-remove. The library is pre-1.0; two code paths for one composition were carrying a migration no consumer had asked for.

- **Both compatibility flags removed**: `AgentToolsetOptions.descriptionIncludesState` and `RegistryOptions.snapshotMergesContextualNote`. `AgentTool.description` never carries live state, and `AgentProcedureDescriptor.description` never carries a contextual note. Hosts render `AgentTool.state` / `contextualNote` themselves ([09 §rendering-capability-state](09-adapters.md#rendering-capability-state)).
- **`stableDescriptionOf` removed** — it existed only to recover the note-free description across the two modes, and `description` now *is* that string.
- `core` back to **18.12 kB**, budget retightened 19 → 18.5 kB.

### v0.6 — meta-mode reliability — shipped (2026-07-31)

The first cycle driven by a *live model* rather than by review or by a host's catalog size. Both defects were in `mode:"meta"`, both in the part of it no conformance requirement had reached, and neither touched `direct`. Manifest 91 → 93/93.

- **A meta verb enforces its own envelope** (`AS-META-007`, D32): the three verb schemas declared `required` and `additionalProperties:false` and never checked them, so a `surface_act` with no `capabilityId` came back `EXECUTION_FAILED{handler-error, retry:"no"}` — a caller's mistake reported as an internal defect, carrying the one hint that tells a model to stop.
- **`surface_act.input` is typed, and a stringified object is repaired** (`AS-META-008`, D32): untyped, it was the only property a provider's constrained decoder could not constrain, so models fell back to the `function_call.arguments` prior their training carries.
- **`decodeWireName` refuses by structure, not by substring** (`AS-ID-004`, `AS-WIRE-007`): a segment named `at` or `0` no longer costs a capability its faithful encoding. Found by the property suite on a random seed; closed a real encoder ambiguity for `domain:` paths containing `_`.
- `core`'s size budget revised 18.5 → 19.5 kB (measured 18.86 kB) — the envelope check and its error strings, paid once, against descriptions re-billed per request.

### v0.7 — `meta` is Experimental again — shipped (2026-07-31)

No behavior change: a stability label, and the documentation debt that had accumulated behind it.

- **`mode:"meta"` returns to Experimental** (D29). Two protocol-level defects in one minor, in the verbs' own envelope, is not what a supported label should absorb — and the graduation suite could not have caught either, since it pins what the mode does *differently* from `direct`. Graduation is re-earnable: envelope requirements that hold across a release, plus a host running it in production. See [09 §meta-tools-mode](09-adapters.md#meta-tools-mode).
- **Lockstep versioning realigned.** 0.6.0 released `core` alone, leaving the other four at 0.5.1 against the rule in `.changeset/README.md` that all `@agent-surface/*` packages ship one version. 0.7.0 puts all five back on the same number; those four skip 0.6.0 on npm, where it was never published for them.
- **A documentation truth pass**, since three published claims had gone stale at once: the README's package versions and test/requirement counts, this file's missing v0.6 entry, and [15](15-completeness-review.md) still calling D25 "specified, deliberately unimplemented" three releases after 0.2 implemented it. The pattern worth naming — a version slot written *before* the release and never recut afterwards — is what produced both the missing v0.6 entry and this one; a shipped release recuts its own slot in the same PR.

### v0.8 — adoption and enforcement

- API extraction + public type-compatibility checks in CI ([17 §8.3](17-maintainer-directive.md)).
- CI regression thresholds on the runtime benchmarks, once baselines are stable on CI hardware rather than a dev machine ([02 §budgets](02-architecture.md#bundle-and-performance-budgets-first-measured-baselines)).
- Higher-cardinality interleaving fuzz over the full pipeline ([15](15-completeness-review.md) item 2), and a presentation-only starter example so a newcomer's first contact is not the full oRPC+confirmation app ([15](15-completeness-review.md) item 7). Both slipped 0.2 through 0.7.
- A tracked expiry for the advisory `typescript@next` job, which fails on a `.d.ts`-bundler incompatibility with TypeScript 7 rather than on our types ([17 §7.4](17-maintainer-directive.md) forbids leaving it allowed-to-fail untracked).
- Browser matrix (Chromium/Firefox/WebKit) — deferred until it buys something: `webmcp` is the only browser-API surface and it is Experimental.
- OQ-1 decided and implemented: the `orpc-agent` manifest source (overdue — it was due before M9, which has shipped).
- Second adoption context, the real Gate 3 blocker. A second application, or a materially different section of the first, is what tells us whether the abstraction generalizes.
- Security review pass against [17 §7.5](17-maintainer-directive.md).

### Later (unscheduled, in rough order of pull)

- MCP bridge (once pairing/session questions in [09](09-adapters.md#mcp-bridge-future) have answers).
- Cross-tab / multi-window surface aggregation.
- Iframe/worker isolation for third-party registrants (real trust boundaries).
- Deep binding paths; binary/content-ref payloads; streaming observations.
- Server-side-agent contextual gating protocol (OQ-5 — needs a design of its own).
- Framework adapters beyond React (Vue/Svelte/Solid) — the core is ready; demand decides.

## Stability policy

| Label | Meaning | Change policy |
|---|---|---|
| Draft | intended shape for 1.0 | breaking changes allowed in minors, always documented + migration note |
| Experimental | opt-in, learning phase | may change or vanish in any release |
| Stable (post-1.0) | semver-guaranteed | breaking only in majors |

Graduation criteria to Stable (all required): used by the example app and ≥1 real application; covered by normative tests in `@agent-surface/testing`; no open spec inconsistencies touching it in [13-open-questions.md](13-open-questions.md); survived one minor release without incompatible change.

## Release engineering

- pnpm workspace, Changesets, semver pre-releases (`0.x`), provenance-signed publishes.
- Every package ships ESM + `.d.ts`, `sideEffects: false`, size-limit budget enforced in CI ([02 §budgets](02-architecture.md#bundle-and-performance-budgets-first-measured-baselines)).
- CI matrix (live): Node 20.19/22 × React 18.2/19 with Strict Mode exercised inside the React suites; `typescript@next` advisory (`continue-on-error` — types are API here, but an upstream regression is not a release gate); Zod and Valibot through Standard Schema; out-of-workspace ESM import and a Vite bundle of the example app.
- Not yet in CI: API extraction/type-compatibility reports, runtime benchmark thresholds, browser matrix. All three are v0.8 ([17 §7](17-maintainer-directive.md)) — they were scoped to v0.3 and have slipped with the rest of the enforcement work.
