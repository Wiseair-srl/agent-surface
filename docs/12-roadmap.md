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

- **Capability state is data, not description text** (`AS-CACHE-001…004`, D28). Tool definitions are the provider's cached prompt prefix; folding `available` into the description re-billed the conversation on every click. `AgentTool.state` and `AgentProcedureDescriptor.contextualNote`, behind compatibility flags for one minor.
- **`mode:"meta"` graduated to supported** (`AS-META-001…005`, D29) on a suite pinning what makes it different. An Experimental marker on the library's only answer for an oversized catalog made it unreachable exactly where it was needed.
- **Wire names fit the provider budget and keep their identity** (`AS-WIRE-004…007`, D30): collision-checked per emitted catalog, reversed through `wireNameMap()`, and `decodeWireName` now refuses rather than returning a plausible wrong id.

Breaking, as a 0.x minor may be ([stability policy](#stability-policy)): `AgentTool.state` is required for anyone *constructing* a tool, and wire names can no longer be reversed by string surgery.

### v0.4 — adoption and enforcement

- **Discovery says what it withheld** (`AS-META-006`, D31): `surface_discover` marks a scope the configured floor refused, so an empty payload is no longer indistinguishable from an empty surface, and the three meta verbs describe their parameters. Manifest 90 → 91/91.
- API extraction + public type-compatibility checks in CI ([17 §8.3](17-maintainer-directive.md)).
- CI regression thresholds on the runtime benchmarks, once baselines are stable on CI hardware rather than a dev machine ([02 §budgets](02-architecture.md#bundle-and-performance-budgets-first-measured-baselines)). The `core` bundle is the pressing one: 18.33 kB against a limit deliberately revised to 19 kB for D31. The D28 *default flip* due this release does not hand that back — both branches stay while the flags exist — so the budget holds until 0.5 removes them ([19 §C4](19-catalog-scale-rfc.md), one minor later than the RFC's numbering because D28 landed in 0.3).
- Higher-cardinality interleaving fuzz over the full pipeline ([15](15-completeness-review.md) item 2), and a presentation-only starter example so a newcomer's first contact is not the full oRPC+confirmation app ([15](15-completeness-review.md) item 7). Both slipped 0.2 and 0.3.
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
- Not yet in CI: API extraction/type-compatibility reports, runtime benchmark thresholds, browser matrix. All three are v0.3 ([17 §7](17-maintainer-directive.md)).
