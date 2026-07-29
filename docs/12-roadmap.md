# 12 — Roadmap

> [!NOTE]
> **Status:** planning document, not a commitment. Versions are pre-1.0: minor versions may break APIs labeled Draft, and WILL break APIs labeled Experimental. Every release documents breaking changes; the spec in `docs/` is updated in the same PR as the code that changes behavior.

## Version plan

### v0.1 — the core loop (maps to milestones M0–M8, [14-implementation-plan.md](14-implementation-plan.md))

The smallest release that proves the thesis end to end on the presentation plane:

- `@agent-surface/core`: ids, schema layer (D19 subset), registry, registration lifecycle, availability, versioning/staleness, invocation pipeline, concurrency/timeout/cancellation, policy pipeline + built-ins, confirmation protocol, audit events, toolset (direct mode).
- `@agent-surface/react`: provider, `useAgentComponent`, `usePendingConfirmations`, full lifecycle semantics (Strict Mode, Suspense, SSR, instances).
- `@agent-surface/testing`: core harness, React harness, matchers, semantic snapshots.
- Embedded toolset adapter with `wait`/`two-phase` confirmations.

Explicitly *not* in v0.1: oRPC package (the extension seams ship, the package doesn't), granular React hooks beyond Experimental flag, meta-tools, WebMCP, budgets.

### v0.2 — the domain plane

- `@agent-surface/orpc`: bridge, manifest contract, `bindAgentProcedure`, `useAgentProcedure`, binding semantics (D7/D8), executor, exposure gating.
- Example application (devices page from [10-examples.md](10-examples.md)) as a repo package + its full test suite — the acceptance artifact for the whole spec.
- Confirmation UX helpers hardened by the example.

### v0.3 — transports and scale

- `@agent-surface/webmcp` (Experimental), tracking the spec of the moment.
- Meta-tools mode; snapshot budgets/priority (graduating from Experimental if the example app proves them).
- First pass on relevance/scoping guidance for large surfaces (informed by real catalogs, not speculation).

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
- Every package ships ESM + `.d.ts`, `sideEffects: false`, size-limit budget in CI ([02 §budgets](02-architecture.md#bundle-and-performance-budgets-targets-not-yet-measured)).
- React CI matrix: 18.2 / 19 / Strict Mode on; TypeScript matrix: current + `typescript@next` (types are API here).
