# @agent-surface/cli

## 0.12.1

### Patch Changes

- 0fbec0d: Make large CLI reports useful at a glance.

  `inspect --depth static` groups capabilities by component and unread sites by file/reason while preserving every copyable allowlist key. `--detail` restores raw origins and diagnostics.

  `check` leads with a PASS/FAIL health matrix. Passing non-gating inventories stay summarized unless `--detail` is requested. Open-handle warnings are structured instead of one long line.

- Updated dependencies [0fbec0d]
  - @agent-surface/core@0.12.1
  - @agent-surface/react@0.12.1
  - @agent-surface/testing@0.12.1

## 0.12.0

### Minor Changes

- 5a6f8b3: Make CLI discovery complete and deterministic.

  ```tsx
  import { useAgentComponent as useAC } from "@agent-surface/react";
  useAC({ type: "alias.panel", … });    // was in neither list
  ```

  Aliased/namespaced imports are resolved. First-party workspace program files are scanned; agent-surface implementation files are excluded. Unread allowances now key one semantic site.

  One normalized scenario report feeds JSON, snapshots, and checks. It always includes hidden capabilities and removes timestamps, runtime ids, and absolute checkout paths.

  Full depth joins the configured authoritative oRPC manifest. Config/CLI scope applies across catalog, runtime, domain, and labels. Rejected registrations fail `check`.

  Snapshots write a scenario manifest. Removed/stale scenarios fail; corrupt baselines exit 2; unsafe scenario names are rejected.

  ### Upgrading

  `check` will fail on a codebase that passed before, until you re-accept the surface once. This is the ratchet catching up, not a regression — but it is why this is a minor rather than a patch.

  ```bash
  agent-surface snapshot && git add .agent-surface
  ```

  That covers the first four below. Read the diff before committing it: on a codebase with an aliased or namespaced registration, the catalog is genuinely larger than it was.

  - **Baseline documents gained `capabilities` and `rejections`.** Every scenario reports drift until re-snapshotted.
  - **`.agent-surface/scenarios.json` is new and required.** Without it `check` reports scenario drift. `snapshot` writes it; commit it.
  - **Baseline files for scenarios the config no longer declares now fail.** Delete them.
  - **Unread allowances are re-keyed** from `file#reason` to `file#reason#site`. Existing entries in `unresolved-allow.json` read as stale, and a stale entry fails even through `--allow-unresolved`. Re-paste the keys `inspect` prints under each unread entry.
  - **Rejected registrations now fail `check`.** Previously they were reported by `inspect` and `--json` only. A duplicate `(type, instanceId)` that CI accepted before will now stop it.
  - **A baseline that exists but does not parse exits 2** ("could not run") instead of reading as a missing baseline.
  - **Workspace sources outside the config's directory are now analyzed.** Only agent-surface's own implementation packages are excluded, so a monorepo that aliases its app across packages gains authored capabilities — and may gain unreached ones with them.

### Patch Changes

- Updated dependencies [5a6f8b3]
  - @agent-surface/core@0.12.0
  - @agent-surface/react@0.12.0
  - @agent-surface/testing@0.12.0

## 0.11.1

### Patch Changes

- c4036aa: Fix a static-catalog soundness hole (#29), resolve wrapper hooks (#31), add per-entry acceptance for unread call sites (#30), restore version lockstep, and rewrite the CLI reference page to describe the tool rather than its history.

  **A spread of members no longer disappears (#29).** `useAgentComponent({ type: "x", ...buildMembers() })` was dropped from the catalog _and_ from the unread call sites, so the count claimed a completeness it did not have — the one failure the static half exists to prevent. The extractor now resolves what a spread can contribute: a written-out key set with no capability group stays quiet (`...(props.instance ? { instanceId } : {})`, the shape every example uses), and anything it cannot read is reported unread. This holds even when a literal `observations` alongside the spread resolved perfectly, because that half says nothing about the `actions` the spread may add.

  Repositories using that shape will see new `UNREAD CALL SITES` entries, and `check` will fail until they are fixed or `--allow-unresolved` accepts them. That is the point: those capabilities were always missing from the count.

  **Lockstep.** The 0.11.0 changeset named only `core` and `cli`, so `react`, `orpc`, `testing` and `webmcp` took dependent patch bumps to 0.10.1 instead of riding to 0.11.0 — the failure `.changeset/README.md` warns about, where a release changeset gets written as a description of the diff instead of as the lockstep declaration it is. Their manifests are realigned to 0.11.0 here and this changeset carries all six to the next patch.

  **Those four skip 0.11.0 on npm** (0.10.1 → 0.11.1). Nothing was published at 0.11.0 for them, so the gap is a numbering artifact of the repair, not a silent release.

  **Wrapper hooks resolve one hop up (#31).** `useAgentComponent({ type })` where `type` is a parameter now resolves from the wrapper's call sites, emitting one capability set per string literal — the same one-hop budget the extractor already spends going sideways to a same-module `const`. A single shared wrapper accounted for 91% of one real application's surface, all of it previously invisible. A call site is resolved only when it provably calls _that_ wrapper (same file, or an import resolving to its file); anything else stays unread, because a fabricated catalog entry is worse than a missing one. Resolution is per call site, so literals resolve while non-literal callers are reported.

  **Per-entry acceptance for unread call sites (#30).** `.agent-surface/unresolved-allow.json` mirrors `coverage-allow.json`: listed sites stop failing `check`, and a site the extractor can now read fails so the list shrinks. The key is `file#reason` — not the line, which churns on unrelated edits, and not the note, which is prose that gets reworded. `inspect` prints the key under every unread entry. `--allow-unresolved` remains the blanket dial and the two compose.

  **Docs.** `docs/20-cli.md` narrated how the document and the command surface reached their current shape. A reference page is for someone using the tool now; the roadmap, the decision log and RFC 21 carry the history. No code, no behaviour, no API change.

- Updated dependencies [c4036aa]
  - @agent-surface/core@0.11.1
  - @agent-surface/react@0.11.1
  - @agent-surface/testing@0.11.1

## 0.11.0

### Minor Changes

- 33da211: **CLI: five commands became four, and the gap between what you author and what a scenario reaches now fails the gate.**

  `capabilities` and `coverage` are gone. They split the command surface along an implementation seam — _does this boot a TypeScript program? does it need jsdom?_ — rather than along a question anybody has, and the cost was a hole in CI: `check` gated on drift alone and printed a line saying that capabilities no scenario mounts were `coverage`'s question. Under a green tick, nobody reads the second line.

  ```bash
  agent-surface init                  # read the codebase, then scaffold a config
  agent-surface inspect [scenario]    # what an agent can reach, and what it cannot
  agent-surface snapshot [scenario]   # write/refresh the committed baseline
  agent-surface check [scenario]      # fail on drift, or on a capability no scenario reaches
  ```

  **Migrating.** `capabilities` → `inspect --depth static`. `coverage` → nothing: the verdict is part of `inspect`, `snapshot` and `check` now. Both were removed rather than aliased; naming either prints where its answer went.

  - **`--depth static|runtime|full`** picks which halves to compute, `full` by default. `static` needs no scenarios and survives an app that will not mount; `runtime` skips the TypeScript program on a repository wide enough to feel it.
  - **`check` fails on four classes**, not one: drift, a missing baseline, an unreached capability, an unread call site. `.agent-surface/coverage-allow.json` ratchets the third; `--allow-unresolved` accepts the fourth. `inspect` reports all four and exits `0` — a viewer that sometimes fails is a viewer nobody pipes.
  - **Exit `2` widened** from _usage error_ to _could not run_, matching `orpc-agent`: an unknown scenario, an unreadable config, a bad `--depth`, or a scenario whose mount threw. CI has to tell "the surface changed" from "the tool never loaded the app".
  - **`inspect` renders a table**, laid out from the content rather than the terminal width. `--detail` keeps the old paragraphs; `--explain` and `--schemas` imply it. Hidden capabilities print as rows without `--explain`, and a hidden row carries no availability reason — authority hides, state discloses, and the two must not look alike.
  - **`inspect --json` changed shape**: `{ depth, catalog, scenarios, failures, coverage }`, each half `null` when the depth did not compute it.

  **Two defects fixed.** `coverage --scope devices` filtered the mount but not the catalog, reporting `app.navigation` capabilities as ones "no scenario mounts" over two that every scenario mounts — the join now uses core's own `matchesScope`, newly re-exported from `@agent-surface/core/explain` (off the agent-facing root). And a scenario that failed to mount still produced a verdict in which everything it would have surfaced counted as unreached; there is now no verdict at all in that case, and the failed scenarios are named.

### Patch Changes

- Updated dependencies [33da211]
  - @agent-surface/core@0.11.0
  - @agent-surface/react@0.10.1
  - @agent-surface/testing@0.10.1

## 0.10.0

### Minor Changes

- dfa2cd7: Answer the other question: which authored capabilities does no scenario reach?

  `inspect` answered _what can an agent do on this page right now_ and was read as answering _did we author something no scenario ever reaches_ — a question nothing in the repository could compute. The two got conflated because the CLI inherited "the catalog is undiscoverable" from "the projection is dynamic". True of the projection: availability, policy outcome and binding are functions of unbounded application state. False of the catalog: `type` is a string literal, capability names are object keys, so `view:devices.table.sort` is fully determined by source text.

  **`agent-surface capabilities` — a static inventory** (`AS-COVER-001…003`, `AS-COVER-006`, D35). Reads the TypeScript program over your own `tsconfig`: no Vite dev server, no jsdom, no scenarios, no mount. One entry per authored capability, each carrying `resolution: "static" | "partial" | "unresolved"` and where to go and read it. A call site the extractor cannot understand is emitted **with its file, line and the construct that defeated it** — never dropped — and the command exits non-zero until you fix it or pass `--allow-unresolved`. A partial understanding of a codebase that reports itself as complete is the exact failure this exists to remove.

  It reads code and creates nothing. No DOM scanning, no annotation generation, no runtime effect. The inventory lives in `@agent-surface/cli`, which no adapter imports and no application ships, and `AS-COVER-006` pins it out of the package root adapters import, mirroring `AS-EXPLAIN-004`.

  **`agent-surface coverage` — authored minus reached** (`AS-COVER-004…005`, D36). Joins the inventory against the union of every scenario's _explanation_ and reports `unreached`, `undeclared` and `unresolved`. The explanation, not the snapshot: a capability a policy hid **was** reached — a scenario mounted it and the policy made a deliberate decision about it — and counting those as gaps would have made the example app's signed-out scenario contribute eleven false ones. Adoption ratchets rather than gates, through a committed `.agent-surface/coverage-allow.json`; an entry that is no longer unreached fails the command, so the list shrinks and cannot silently rot. Exit codes follow `AS-CLI-002`.

  **`cli`: the commands stopped asserting completeness they could not back** (`AS-CLI-006…007`, D37).

  - **Rejected registrations are reported.** A duplicate `(type, instanceId)` or an `onRegister` rejection yields a dead handle that reaches neither the snapshot (it never registered), nor the explanation (`explainSurface()` iterates active registrations), nor any baseline — and its only diagnostic goes through `devError`, which prints nothing under the `environment: "test"` the documented config shape builds. Copy-paste a component `type` and a capability disappeared with no output anywhere. The registry always emitted `component-rejected`; the collector now reads it, renders it, and carries `rejections` as an always-present array in `--json`.
  - **Counts name what they are relative to.** The scenario always, and the scope when one is active — `--scope` filters the snapshot _and_ the explanation, and nothing on screen said so.
  - **`hidden` prints unconditionally.** It was already computed on every run. Suppressing it outside `--explain` meant a policy-emptied surface rendered as `0 callable, 0 visible-disabled` under the words _nothing is registered_, over eleven capabilities that authority had hidden. The attribution still needs `--explain`; only the count moved.
  - **A green `check` names the scenarios it compared**, because it means "the surface did not change _in these scenarios_", never "the surface did not change".

  Still not detectable by anything here: a UI affordance that was never registered. There is no capability, no call site and no registration, so there is nothing to find — human review of the diff remains the only gate, and a green `coverage` must not be read as covering it.

  `core`, `react`, `orpc`, `testing` and `webmcp` carry no code change in this release; they are versioned along with the rest to keep the six packages on one line.

### Patch Changes

- Updated dependencies [dfa2cd7]
  - @agent-surface/core@0.10.0
  - @agent-surface/react@0.10.0
  - @agent-surface/testing@0.10.0

## 0.9.1

### Patch Changes

- d45c057: Keep the CLI's own output uncorrupted, and make it exit.

  Two bugs that only show up once the CLI hosts a non-trivial application.

  **`core`: the development audit sink no longer writes to stdout.** `consoleAuditSink()` used `console.debug`, which is the verbose channel in a browser but an alias of `console.log` in Node — so it wrote to stdout, the stream the CLI renders into. Any app deriving its environment the ordinary Vite way (`import.meta.env.PROD ? "production" : "development"`, and `PROD` is `false` under vite-node) got a registration trace interleaved with the command's output, which made `agent-surface inspect --json` emit unparseable JSON and buried `check`'s drift report in CI. Under Node the sink now writes to stderr; in browsers it stays on `console.debug`. The trail moved streams, it was not silenced (`AS-OBSV-002`, `AS-CLI-004`).

  **`cli`: a command now ends when it is done.** The binary only set `process.exitCode`, so anything the mounted app left running — a polling interval, a websocket, a data layer whose cache timer outlives the render — kept the process alive after the output was complete and correct. It presented as a hang with a successful exit code already set, and nothing on screen to explain it. A finished command is now given a moment to exit on its own; if it does not, the CLI names the handles still holding the loop and exits anyway. A tidy app never sees the message (`AS-CLI-005`).

  Also: `installDom()` returns `void` instead of a disposer that did nothing. The DOM is process-wide and permanent on purpose — `react-dom` captures `window` at import — and the signature now says so rather than reading like teardown at the call site. It is internal to the binary, not a package export, so nothing downstream sees the change.

  `react`, `orpc`, `testing` and `webmcp` carry no code change in this release; they are versioned along with the rest to keep the six packages on one line.

- Updated dependencies [d45c057]
  - @agent-surface/core@0.9.1
  - @agent-surface/react@0.9.1
  - @agent-surface/testing@0.9.1

## 0.9.0

### Minor Changes

- 37ee3a2: `agent-surface inspect` covers every scenario by default

  A bare `inspect` rendered the _first_ scenario in the config — `Object.keys` order, with nothing on screen saying so. `snapshot` and `check` have always covered all of them, so the one command you read with your eyes was the one that quietly showed you a subset, and reordering two keys in a config file changed what it showed. It now renders every scenario, in the order the config lists them, each mounted and printed before the next is mounted so a slow config prints as it goes. Naming one still renders only that one.

  **`inspect --json` changed shape**: it now always emits `{ "scenarios": [ { "scenario", "snapshot", "explanation"? } ] }`, a one-element array when you named a scenario. The alternative was a document whose top-level shape depended on how the command was invoked, which every consumer would have to branch on. Nothing else moved — the per-scenario entry is byte-for-byte what the top level used to be, `--explain` still gates `explanation`, and the plain-text and Ink renderings of a single scenario are unchanged.

  No API surface changed in any other package; the lockstep bump keeps the versions aligned.

### Patch Changes

- Updated dependencies [37ee3a2]
  - @agent-surface/core@0.9.0
  - @agent-surface/react@0.9.0
  - @agent-surface/testing@0.9.0

## 0.8.0

### Minor Changes

- 8dd044c: The surface is inspectable: `@agent-surface/cli` and `explainSurface()`

  A sixth package joins the lockstep, plus the one core addition it needed. Manifest 93 → 100/100.

  **`explainSurface()`** — new, behind its own entry point `@agent-surface/core/explain`. `snapshot()` bakes policy _outcomes_, so a `hide` deletes the capability and the reason together. That is correct at the agent boundary — the existence of a hidden capability is itself information — and it left "why is my capability missing?" as a manual policy bisect. The explanation reports every capability the registry holds, hidden ones included, with each policy in the chain: its name, the layer it came from, its own discovery vote, the phases it implements, and whether its `onDiscovery` threw (a defect `evaluateDiscovery` fails closed on, silently). `availability` is reported apart from the policy votes, because _authority hides, state discloses_ and the two failures must not look alike.

  It is **never agent-facing**, and that is enforced structurally rather than by a runtime flag: `AS-EXPLAIN-004` fails the build if `explainSurface` ever appears on the package root that adapters import. `AS-EXPLAIN-003` pins its composed outcome to the snapshot's for the same context.

  **`@agent-surface/cli`** — `agent-surface inspect | snapshot | check`.

  - `inspect` renders the live surface with effect, idempotency, confirmation level, bound-and-locked fields, and the reason a capability is not callable. `--explain` adds the policy attribution above, including the capabilities the snapshot omits.
  - `check` compares committed baselines and exits non-zero on any drift — descriptions included, since those are the provider's cached prompt prefix. Same `serializeSurfaceSnapshot` normalizer the Vitest matcher uses.
  - Configuration points at the app's existing composition root rather than restating it, and the same scenarios feed the test suite through `@agent-surface/cli/vitest`. In `devices-app` that _deleted_ the suite's own `renderApp()` helper: one definition of "admin on /devices", three consumers.

  `core`'s main entry is unchanged at 18.9 kB against its 19.5 kB budget; `explain` is a separate 1.41 kB entry that tree-shakes out of anything not importing it. No behavior change to any existing API.

### Patch Changes

- Updated dependencies [8dd044c]
  - @agent-surface/core@0.8.0
  - @agent-surface/react@0.8.0
  - @agent-surface/testing@0.8.0
