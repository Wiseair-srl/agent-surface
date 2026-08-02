# 12 — Roadmap

> [!NOTE]
> **Status:** planning document, not a commitment. Versions are pre-1.0: minor versions may break APIs labeled Draft, and WILL break APIs labeled Experimental. Every release documents breaking changes; the spec in `docs/` is updated in the same PR as the code that changes behavior.

## Version plan

> [!NOTE]
> **Re-cut after 0.1.0.** The original plan staged the packages across v0.1/v0.2/v0.3; 0.1.0 actually shipped all five (`core`, `react`, `orpc`, `testing`, `webmcp`) plus the example app, meta-tools mode, and budgets. Feature staging is therefore no longer the useful axis. What is left is *maturity*: the gap between "implemented" and "proven, enforced, and adopted twice" ([Maintainer directive §11 release gates](17-maintainer-directive.md)).

### v0.1 — shipped (2026-07-30)

All five packages, the `devices-app` example as the behavioral acceptance artifact, the conformance manifest with named tests, and the P0 protocol corrections D21–D26.

Known gaps at 0.1.0, all now closed or scheduled below: D25 concurrency groups were specified but unimplemented; meta-tools mode diverged from the direct-mode contract; CI ran a single Node/React combination.

### v0.2 — trust — shipped (2026-07-31)

No new surface area. Everything here closed a gap between what the docs promised and what CI proved:

- **Meta-tools parity** (`AS-ADAPTER-004/005`, D27): identical resolution to direct mode, adapter scope as a floor, meta-only budgets.
- **D25 concurrency groups** (`AS-CONC-001`): the last requirement that was `specified` rather than `implemented` — the manifest reached 77/77.
- **Support matrix**: Node 20.19/22 × React 18.2/19, out-of-workspace ESM import, Vite bundle smoke, advisory `typescript@next`, Valibot alongside Zod through Standard Schema.

### v0.3 — catalog scale — shipped (2026-07-31)

The first correction cycle driven by a host rather than by self-review: a dashboard at ~300 domain capabilities and 40+ mounted view capabilities per route ([Catalog Scale RFC](19-catalog-scale-rfc.md), D28–D30). Manifest 77 → 90/90.

- **Capability state is data, not description text** (`AS-CACHE-001…004`, D28). Tool definitions are the provider's cached prompt prefix; folding `available` into the description re-billed the conversation on every click. `AgentTool.state` and `AgentProcedureDescriptor.contextualNote`, behind compatibility flags intended to last one minor — removed in [v0.5](#v05--the-split-is-the-only-composition--shipped-2026-07-31) without ever flipping.
- **`mode:"meta"` graduated to supported** (`AS-META-001…005`, D29) on a suite pinning what makes it different. An Experimental marker on the library's only answer for an oversized catalog made it unreachable exactly where it was needed. *(Reversed in [v0.7](#v07--meta-is-experimental-again--shipped-2026-07-31): the suite covered the mode's distinguishing behaviors, not its verb envelope, which is where 0.6 then found two defects.)*
- **Wire names fit the provider budget and keep their identity** (`AS-WIRE-004…007`, D30): collision-checked per emitted catalog, reversed through `wireNameMap()`, and `decodeWireName` now refuses rather than returning a plausible wrong id.

Breaking, as a 0.x minor may be ([stability policy](#stability-policy)): `AgentTool.state` is required for anyone *constructing* a tool, and wire names can no longer be reversed by string surgery.

### v0.4 — discovery honesty — shipped (2026-07-31)

One decision, cut on its own rather than held for the D28 default flip that this slot was reserved for — see the schedule note below.

- **Discovery says what it withheld** (`AS-META-006`, D31): `surface_discover` marks a scope the configured floor refused, so an empty payload is no longer indistinguishable from an empty surface, and the three meta verbs describe their parameters. Manifest 90 → 91/91.
- `core`'s size budget was deliberately revised 18 → 19 kB (measured 18.33 kB) — the parameter descriptions are the change, so the bytes are payload the model reads ([Architecture §budgets](../02-architecture.md#bundle-and-performance-budgets)).

> [!NOTE]
> **The D28 compatibility flags did not flip here.** They were removed outright in [v0.5](#v05--the-split-is-the-only-composition--shipped-2026-07-31) instead — the schedule had already slipped twice and the deferred migration was buying nothing pre-1.0.

### v0.5 — the split is the only composition — shipped (2026-07-31)

The D28 migration ended by deletion rather than by the planned flip-then-remove. The library is pre-1.0; two code paths for one composition were carrying a migration no consumer had asked for.

- **Both compatibility flags removed**: `AgentToolsetOptions.descriptionIncludesState` and `RegistryOptions.snapshotMergesContextualNote`. `AgentTool.description` never carries live state, and `AgentProcedureDescriptor.description` never carries a contextual note. Hosts render `AgentTool.state` / `contextualNote` themselves ([Adapters §rendering-capability-state](../09-adapters.md#rendering-capability-state)).
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

- **`mode:"meta"` returns to Experimental** (D29). Two protocol-level defects in one minor, in the verbs' own envelope, is not what a supported label should absorb — and the graduation suite could not have caught either, since it pins what the mode does *differently* from `direct`. Graduation is re-earnable: envelope requirements that hold across a release, plus a host running it in production. See [Adapters §meta-tools-mode](../09-adapters.md#meta-tools-mode).
- **Lockstep versioning realigned.** 0.6.0 released `core` alone, leaving the other four at 0.5.1 against the rule in `.changeset/README.md` that all `@agent-surface/*` packages ship one version. 0.7.0 puts all five back on the same number; those four skip 0.6.0 on npm, where it was never published for them.
- **A documentation truth pass**, since three published claims had gone stale at once: the README's package versions and test/requirement counts, this file's missing v0.6 entry, and [Completeness review](15-completeness-review.md) still calling D25 "specified, deliberately unimplemented" three releases after 0.2 implemented it. The pattern worth naming — a version slot written *before* the release and never recut afterwards — is what produced both the missing v0.6 entry and this one; a shipped release recuts its own slot in the same PR.

### v0.8 — the surface is inspectable — shipped (2026-07-31)

A sixth package, `@agent-surface/cli`, and the one core addition it needed. Manifest 93 → 100/100.

- **`explainSurface()`** (`AS-EXPLAIN-001…004`, D33): the developer projection, reporting every capability the registry holds — hidden ones included — with each policy's own vote. Behind its own entry point (`@agent-surface/core/explain`), kept off the package root by a build-failing test ([Policies & Security §explain is never agent-facing](../06-policies-and-security.md#explain-is-never-agent-facing)).
- **`agent-surface inspect` / `snapshot` / `check`** (`AS-CLI-001…003`, [CLI](../20-cli.md)): the committed-baseline gate as a command rather than a test file, on the same `serializeSurfaceSnapshot` normalizer, exiting non-zero on any drift — descriptions included, since those are the provider's cached prefix (D28).
- **Scenarios are shared, not duplicated.** `agent-surface.config.tsx` points at the app's existing composition root, and `@agent-surface/cli/vitest` feeds the same scenarios to the test suite. In `devices-app` this deleted the suite's own `renderApp()` helper: one definition of "admin on /devices", three consumers.
- `core`'s main entry unchanged at 18.9 kB; `explain` is a separate 1.41 kB entry that tree-shakes out of anything not importing it.

### v0.9 — the CLI meets an application that is not this one — shipped (2026-08-01)

Three defects, none of them in the surface data — the committed baselines are byte-identical across the whole slot. `agent-surface` was pointed at a Vite + React 19 dashboard outside this repo, and everything it got wrong was about *hosting*: which stream a write lands on, and when a process is allowed to end. The example app had masked all three by being tidy. Manifest 100 → 103/103.

- **`inspect` covers every scenario by default** (0.9.0). A bare `inspect` had rendered whichever scenario `Object.keys` returned first, so reordering two config keys changed what it showed. **`inspect --json` changed shape** in the same release — always `{ "scenarios": [ … ] }`, a one-element array when you name one — because a document whose top-level shape depends on how the command was invoked is one every consumer has to branch on.
- **stdout is the output; stderr is everything else** (`AS-OBSV-002`, `AS-CLI-004`, D34, 0.9.1). `consoleAuditSink()` used `console.debug`, which is an alias of `console.log` under Node, so a registry built the documented Vite way put its audit trail on the stream `inspect --json` renders into. The trail moved to stderr; it was not silenced ([Policies & Security §audit](../06-policies-and-security.md#audit)).
- **A finished command exits** (`AS-CLI-005`, D34, 0.9.1). Any handle the mounted app left behind used to keep the process alive after its output was complete — a hang presenting as success. An unref'd grace timer now detects that, names the handles, and exits ([CLI §exiting](../20-cli.md#exiting)).
- **The slot's original theme did not ship.** "Adoption and enforcement" moved on intact, recorded rather than quietly re-dated, per the rule v0.7 wrote down after the same thing happened at 0.6. Fourth occurrence.

### v0.10 — surface coverage — shipped (2026-08-01)

[Surface Coverage RFC](21-surface-coverage-rfc.md), D35–D37, manifest 103 → 111/111. `inspect` answered *what can an agent do here right now* and was quietly read as answering *did we author something no scenario reaches* — a question nothing in the repository could compute. The gap came from inheriting "the catalog is undiscoverable" from "the projection is dynamic": true of the projection, false of the catalog, since `type` is a string literal and capability names are object keys.

- **A static inventory** (`AS-COVER-001…003`, `AS-COVER-006`, D35). `agent-surface capabilities` reads the TypeScript program — no Vite server, no jsdom, no scenarios, no mount — and emits one entry per authored capability with `resolution: static | partial | unresolved`. An unreadable call site is reported with its file, line and the construct that defeated the extractor, and the command exits non-zero unless `--allow-unresolved` is passed. It reads code and creates nothing; directive §2.1 is untouched ([CLI §capabilities](../20-cli.md#capabilities)).
- **`coverage`: authored minus reached** (`AS-COVER-004…005`, D36). Joins the inventory against the union of every scenario's *explanation* rather than its snapshot, so a policy-hidden capability counts as reached. Adoption ratchets through a committed `.agent-surface/coverage-allow.json` whose stale entries fail the command ([CLI §coverage](../20-cli.md#coverage)).
- **The CLI stopped asserting completeness it could not back** (`AS-CLI-006…007`, D37). Registrations the registry refused are reported, counts name their scenario and scope, `hidden` prints unconditionally, and a green `check` names the scenarios it compared.
- **Still not detectable by anything here:** a UI affordance that was never registered. There is no capability, no call site, no registration — nothing to find. Human diff review remains the only gate, and a green `coverage` must not be read as covering it.
- **The slot's other theme did not ship, again.** "Adoption and enforcement" moves to [v0.11](#v011--adoption-and-enforcement) intact — the fifth time, and the rule v0.7 wrote down is evidently easier to write than to keep.

### v0.11 — one command per question, and adoption

Two themes, and this time both are in the slot rather than one of them moving on again.

**CLI ergonomics** ([21 §amendment](21-surface-coverage-rfc.md#amendment--the-command-cut-was-wrong-d38), D38, `AS-CLI-008`, `AS-COVER-007`, manifest 111 → 113/113). v0.10 recovered the catalog by adding two commands, and cut the surface along an implementation seam — *does this boot a TypeScript program? does it need jsdom?* — rather than along a question anyone has. The tell was `check`'s own success line, which printed a green tick and then named the question it had declined to answer: *capabilities no scenario mounts are `agent-surface coverage`'s question*. In CI nobody reads the second line, so an unreached route passed.

- **Five commands became four** — `init` / `inspect` / `snapshot` / `check`, matching `orpc-agent`. `capabilities` is `inspect --depth static`; `coverage` is folded into all three mounting commands. Removed rather than aliased; naming either still prints where its answer went.
- **`--depth static|runtime|full`** selects which halves are computed, `full` by default: a tool that has to be asked for the complete answer mostly gives the incomplete one. The v0.10 objection — *"that would force a TypeScript program boot into every `inspect`"* — was real and never measured: under a second on the example app. `--depth runtime` is the escape hatch for the repository where it genuinely bites.
- **The gap fails the gate.** `check` now fails on drift, a missing baseline, an unreached capability, or an unread call site; `inspect` reports all four and exits `0`, because a viewer that sometimes fails is a viewer nobody pipes. Exit `2` widened from *usage error* to *could not run* — `orpc-agent`'s meaning — so CI can tell "the surface changed" from "the tool never loaded the app".
- **Two defects the merge surfaced**, both of the class v0.10 existed to remove. `coverage --scope devices` filtered the mount but not the catalog, reporting two `app.navigation` capabilities as ones "no scenario mounts" over two that every scenario mounts; the join now calls core's own `matchesScope` rather than a second copy. And a scenario that failed to mount still produced a verdict, in which everything it would have surfaced counted as unreached — there is now no verdict at all in that case, and the failed scenarios are named.
- **`inspect` renders a table**, one capability per line, laid out from the content and never from `process.stdout.columns` — a table sized against the terminal it ran in is byte-stable only until two people diff the same CI log from different windows. `--detail` keeps the paragraphs; `--explain`/`--schemas` imply it. Hidden capabilities print as rows without `--explain`, finishing what `AS-CLI-007` started with the count, and a hidden row carries no availability reason: *authority hides, state discloses* (D11/D12), and printing "The drawer is not open" under a row marked `hidden` conflates them.
- **`init`** reads the codebase, prints what it found, and only then offers to scaffold a config. It cannot probe an entry the way `orpc-agent init` does — a surface config needs a `mount()`, and there is no export a tool can import to get one.
- **One report, one look** (D39, `AS-CLI-014`). The four commands rendered to three different standards, because the renderer was chosen at each call site rather than once for the run: `check` and `snapshot` drew no terminal UI at all — a `check` on a real repository was seventeen silent seconds and then a wall of plain text — `inspect` printed its static catalog and its mount failures as raw text in the middle of a drawn report, and one report carried two text columns because each block sized its own label field. The commands now build a report model and a presenter draws it, picking Ink or plain text **per stream**, owning the spacing, and holding one label grid throughout. `check` stays plain wherever it is read — piped, `CI`, `NO_COLOR` — which was the whole content of "`check` is always plain"; what it lost was the branch, not the guarantee.

**Adoption and enforcement.** Carried from v0.9 and v0.10:

- API extraction + public type-compatibility checks in CI ([Maintainer directive §8.3](17-maintainer-directive.md)).
- CI regression thresholds on the runtime benchmarks, once baselines are stable on CI hardware rather than a dev machine ([Architecture §budgets](../02-architecture.md#bundle-and-performance-budgets)).
- Higher-cardinality interleaving fuzz over the full pipeline ([Completeness review](15-completeness-review.md) item 2), and a presentation-only starter example so a newcomer's first contact is not the full oRPC+confirmation app ([Completeness review](15-completeness-review.md) item 7). Both slipped 0.2 through 0.9.
- A tracked expiry for the advisory `typescript@next` job, which fails on a `.d.ts`-bundler incompatibility with TypeScript 7 rather than on our types ([Maintainer directive §7.4](17-maintainer-directive.md) forbids leaving it allowed-to-fail untracked).
- Browser matrix (Chromium/Firefox/WebKit) — deferred until it buys something: `webmcp` is the only browser-API surface and it is Experimental.
- OQ-1 decided and implemented: the `orpc-agent` manifest source (overdue — it was due before M9, which has shipped).
- Second adoption context, the real Gate 3 blocker. A second application, or a materially different section of the first, is what tells us whether the abstraction generalizes.
- Security review pass against [Maintainer directive §7.5](17-maintainer-directive.md).
- OQ-13 and OQ-14 revisited once a real codebase exercises the granular hooks and dynamic registration ([Decisions, Part B](13-open-questions.md#part-b--genuinely-open-questions)).

### Later (unscheduled, in rough order of pull)

- MCP bridge (once pairing/session questions in [Adapters](../09-adapters.md#mcp-bridge-future) have answers).
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

Graduation criteria to Stable (all required): used by the example app and ≥1 real application; covered by normative tests in `@agent-surface/testing`; no open spec inconsistencies touching it in [Decisions](13-open-questions.md); survived one minor release without incompatible change.

## Release engineering

- pnpm workspace, Changesets, semver pre-releases (`0.x`), provenance-signed publishes.
- Every package ships ESM + `.d.ts`, `sideEffects: false`, size-limit budget enforced in CI ([Architecture §budgets](../02-architecture.md#bundle-and-performance-budgets)).
- CI matrix (live): Node 20.19/22 × React 18.2/19 with Strict Mode exercised inside the React suites; `typescript@next` advisory (`continue-on-error` — types are API here, but an upstream regression is not a release gate); Zod and Valibot through Standard Schema; out-of-workspace ESM import and a Vite bundle of the example app.
- Not yet in CI: API extraction/type-compatibility reports, runtime benchmark thresholds, browser matrix. All three are v0.10 ([Maintainer directive §7](17-maintainer-directive.md)) — they were scoped to v0.3 and have slipped with the rest of the enforcement work.
