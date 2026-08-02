# @agent-surface/core

## 0.17.0

### Minor Changes

- 1c4bf21: Make compiler authority mandatory across registration and exposure boundaries.

  - Verify and freeze format-v4 manifests at runtime.
  - Keep compiler proof private and compare runtime semantics to source truth.
  - Remove raw React/oRPC execution paths and unsafe adapter execute overrides.

## 0.16.0

### Minor Changes

- 45ffc48: Replace runtime surface discovery with compiler-generated capability contracts.

  Add the production-graph compiler, contract/binding APIs, strict manifest-backed runtime enforcement, provider exposure gateway, canonical artifact, and contract diff CLI. Remove scenarios, source extraction, depth limits, and allowlists.

## 0.15.0

### Minor Changes

- 3535e53: Restores lockstep versioning: all six packages ship on 0.15.0.

  0.14.0 released `@agent-surface/cli` alone, because its changeset named only the
  package whose code had changed. The frontmatter of a release changeset is a
  lockstep declaration rather than a description of the diff
  ([.changeset/README.md](../.changeset/README.md)), so the other five were left
  behind at 0.13.0 — the same failure, and the same cause, as 0.6.0 and 0.11.0.

  `core`, `react`, `orpc`, `testing` and `webmcp` were carried to 0.14.0 in the
  manifests and are published here at **0.15.0**; they have **no 0.14.0 on npm**.
  That gap is the repair, not a silent release: nothing shipped in it, and
  `@agent-surface/cli@0.14.0` — which did ship, and works — depends on
  `^0.13.0` of its siblings, so no installed tree was ever inconsistent.

  No functional change in any of the five.

### Patch Changes

- f4ce070: Fixes scenario diagnostics and jsdom event compatibility. React mount failures
  now retain component and JavaScript stack context, empty errors get a useful
  fallback, and global events use jsdom's realm so Radix overlays mount correctly.
- f4ce070: Fixes static extraction of conditional capabilities contributed through readable
  spreads inside `observations` and `actions`. Their identities now enter the
  catalog as partial instead of remaining unresolved.

## 0.13.0

### Minor Changes

- 94a1876: Lead `inspect` and `check` with a summary, and report the gap the coverage join cannot see.

  **Both commands are now written the way they are read: summaries first, details after.**

  `inspect` opens with the run — the config, the depth, the scope every count is relative to, and the scenarios about to mount — printed _before_ the mounts, because all of it is known before them and they are the slow half. Then `SURFACE SUMMARY`: reach, what is callable, what the surface can actually do, the catalog's completeness, and one verdict line, instead of the bare `authored · reached · unreached` that used to close the report. The static catalog and the per-scenario tables follow as detail.

  That order costs the streaming `inspect` used to do — a summary is a statement about every scenario, so it cannot be written until every scenario has mounted. A terminal is told what it is waiting for instead: the header is already on screen, and a spinner names the scenario being mounted and how far through the list it is. `check` has always collected first, and now says the same things in the same shape.

  **New finding: `NEVER CALLABLE`.** Mounted by every scenario, and callable in none of them — a drawer every scenario leaves closed registers its `close` action in each snapshot and can be used in no scenario. `unreached` counts it reached, correctly, so nothing saw this before. Reported by `inspect` (and in `--json` as `neverCallable`), and deliberately not a gate: it is a judgement about your scenarios rather than a defect in the surface. It prints only when more than one scenario ran.

  **Scenario tables.** `check` and multi-scenario `inspect` print one row per scenario — route, callable/disabled/hidden, rejections, and for `check` how its baseline compared. A scenario that failed to mount appears in the table with its error, rather than only at the bottom of the report.

  **Every finding says what to do about it,** and a failing `check` ends with `NEXT STEPS`: the commands that clear the report, in the order worth running them.

  **Fixed: a scoped `check` never named its scope.** `--scope devices` filters the catalog, the mount, and every count in the matrix, but the gate's own report said nothing about it — so `9/9 authored capabilities reached` in CI was a claim about one prefix of the codebase, reading as a claim about all of it (`AS-CLI-007`). The header now names it.

  **Fixed: the domain row claimed the wrong thing at full depth.** With no `manifest` configured it read "not analyzed at static depth" while running at full depth. "Nobody looked" and "there is nothing to look at" are different statements and now read differently.

  Committed baselines, `.agent-surface/` file formats and exit codes are unchanged. `inspect --json` gains `neverCallable`; every existing key keeps its shape.

## 0.12.1

### Patch Changes

- 0fbec0d: Make large CLI reports useful at a glance.

  `inspect --depth static` groups capabilities by component and unread sites by file/reason while preserving every copyable allowlist key. `--detail` restores raw origins and diagnostics.

  `check` leads with a PASS/FAIL health matrix. Passing non-gating inventories stay summarized unless `--detail` is requested. Open-handle warnings are structured instead of one long line.

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

## 0.9.1

### Patch Changes

- d45c057: Keep the CLI's own output uncorrupted, and make it exit.

  Two bugs that only show up once the CLI hosts a non-trivial application.

  **`core`: the development audit sink no longer writes to stdout.** `consoleAuditSink()` used `console.debug`, which is the verbose channel in a browser but an alias of `console.log` in Node — so it wrote to stdout, the stream the CLI renders into. Any app deriving its environment the ordinary Vite way (`import.meta.env.PROD ? "production" : "development"`, and `PROD` is `false` under vite-node) got a registration trace interleaved with the command's output, which made `agent-surface inspect --json` emit unparseable JSON and buried `check`'s drift report in CI. Under Node the sink now writes to stderr; in browsers it stays on `console.debug`. The trail moved streams, it was not silenced (`AS-OBSV-002`, `AS-CLI-004`).

  **`cli`: a command now ends when it is done.** The binary only set `process.exitCode`, so anything the mounted app left running — a polling interval, a websocket, a data layer whose cache timer outlives the render — kept the process alive after the output was complete and correct. It presented as a hang with a successful exit code already set, and nothing on screen to explain it. A finished command is now given a moment to exit on its own; if it does not, the CLI names the handles still holding the loop and exits anyway. A tidy app never sees the message (`AS-CLI-005`).

  Also: `installDom()` returns `void` instead of a disposer that did nothing. The DOM is process-wide and permanent on purpose — `react-dom` captures `window` at import — and the signature now says so rather than reading like teardown at the call site. It is internal to the binary, not a package export, so nothing downstream sees the change.

  `react`, `orpc`, `testing` and `webmcp` carry no code change in this release; they are versioned along with the rest to keep the six packages on one line.

## 0.9.0

### Minor Changes

- 37ee3a2: `agent-surface inspect` covers every scenario by default

  A bare `inspect` rendered the _first_ scenario in the config — `Object.keys` order, with nothing on screen saying so. `snapshot` and `check` have always covered all of them, so the one command you read with your eyes was the one that quietly showed you a subset, and reordering two keys in a config file changed what it showed. It now renders every scenario, in the order the config lists them, each mounted and printed before the next is mounted so a slow config prints as it goes. Naming one still renders only that one.

  **`inspect --json` changed shape**: it now always emits `{ "scenarios": [ { "scenario", "snapshot", "explanation"? } ] }`, a one-element array when you named a scenario. The alternative was a document whose top-level shape depended on how the command was invoked, which every consumer would have to branch on. Nothing else moved — the per-scenario entry is byte-for-byte what the top level used to be, `--explain` still gates `explanation`, and the plain-text and Ink renderings of a single scenario are unchanged.

  No API surface changed in any other package; the lockstep bump keeps the versions aligned.

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

## 0.7.0

### Minor Changes

- f54ff5d: `mode: "meta"` returns to **Experimental** (D29). No behavior change — this is a stability label, and every conformance requirement that gated the mode still passes.

  It was Supported from 0.2 through 0.6, graduated on `AS-META-001…005`: a model scope narrows the configured floor, a disjoint scope yields empty, a truncated payload is marked and still a valid snapshot, `surface_act` keeps direct-mode confirmation and staleness semantics, and tool-block size is invariant in the number of capabilities.

  Those five pin what the mode does _differently_ from `direct`. None of them reaches the three verbs' own envelope — and that is where 0.6 found two defects, both against a live model, both making `meta` materially less reliable than `direct` for the same capabilities:

  - `surface_act.input` was the only untyped property in the block, so a provider's constrained decoder had nothing to constrain and models fell back to the `function_call.arguments` prior (`AS-META-008`);
  - `required` and `additionalProperties: false` were declared on the verb schemas and never enforced, so a missing `capabilityId` came back as `EXECUTION_FAILED {retry:"no"}` — a caller's mistake reported as an internal defect (`AS-META-007`).

  Two protocol-level defects in one minor, in a part of the mode no requirement covered, is not what a supported label should absorb. A suite pinning a mode's distinguishing behaviors is not evidence its contract has settled.

  **What this means for hosts.** Nothing breaks: `mode: "meta"` works exactly as in 0.6, and the pinned behaviors stay under test. Read the marker as _"opt in, and expect the envelope to move"_ — pin the version and re-read [09 §meta-tools-mode](https://github.com/Wiseair-srl/agent-surface/blob/main/docs/09-adapters.md#meta-tools-mode) on upgrade. It remains the library's only answer for a catalog that cannot fit a provider tool block; that cost was weighed when the marker went back on, not overlooked.

  Graduation is re-earnable: envelope-level requirements that hold across a release, plus a host running it in production.

  **Lockstep versioning is realigned.** 0.6.0 released `core` alone, against the rule that every `@agent-surface/*` package ships on the same version, so `react`, `orpc`, `testing` and `webmcp` sat at 0.5.1. All five are 0.7.0 from here; those four skip 0.6.0 on npm, which was never published for them. Nothing about their contents changed in that gap — the skip is bookkeeping, not a silent release.

  Also in this release, a documentation truth pass — published statements that had gone stale: package versions and test/requirement counts in the README, the roadmap's missing v0.6 entry (0.6.0 shipped D32, not the enforcement work its slot described), and `15-completeness-review.md` still calling D25 "specified, deliberately unimplemented" three releases after 0.2 implemented it.

## 0.6.0

### Minor Changes

- 774bec0: `surface_act` validates its own envelope, and its `input` is typed (D32, `AS-META-007`, `AS-META-008`).

  Two defects made `mode: "meta"` materially less reliable than `direct` for the same capabilities. Both were found running a live model against a meta-mode host; direct mode was never affected.

  **`input` was the only untyped property in the meta tool block.** It is now `type: "object"`:

  ```json
  {
    "capabilityId": "view:devices.table.selectRows",
    "input": "{\"ids\": [\"d-to-03\"]}",
    "mode": "replace"
  }
  ```

  That call — a JSON-encoded string where an object belongs, and `mode` hoisted out of `input` to sit beside the call-level modifiers — came back `INVALID_INPUT` from the _capability's_ validator, saying the input does not match the capability's schema. It matched fine; the envelope was wrong, and nothing said so. An untyped property is the one position a provider's constrained decoder cannot constrain, so the model fell back to the convention its training data carries (`function_call.arguments`, a string) and sorted the rest of the arguments into the modifiers it could see. Typing costs nothing: direct mode already passes `act.inputSchema` through as the tool schema, and providers require that to be an object schema at the top level.

  Typing binds providers that honor the schema while generating. For the ones that do not, `surface_act` parses an `input` that arrives as a string — **only** when the resolved target's own schema declares an object, and only when the string parses to a plain object, so a capability that genuinely declares a string input still receives it verbatim. The repair logs a development warning: a silent one is indistinguishable from the model getting it right, which hides the regression the shim absorbs.

  **The verbs' own schemas are now enforced.** `required` and `additionalProperties: false` were declared and never checked, so the envelope reached the pipeline as-is:

  ```ts
  await surface_act({});
  // before → EXECUTION_FAILED { reason: "handler-error", retry: "no" }  + a logged
  //          "invocation pipeline failure" (parseCapabilityId(undefined) threw)
  // after  → INVALID_INPUT { retry: "with-changes", issues: [{ path: "capabilityId", … }] }
  ```

  A caller error was being reported as an internal defect, carrying the one retry hint that tells a model to stop rather than fix its call. Each verb now checks the call against its own declared schema first and returns `INVALID_INPUT` naming the offending property — and for an unknown key, saying it probably belongs inside `input`, which turns the first defect's dead end into a one-retry recovery. Capability-input validation is unchanged and still the registry's: the two check different objects, and only the adapter can tell which one is wrong.

  `parseCapabilityId` also rejects a non-string id instead of throwing, so any other caller reaching it with one gets `CAPABILITY_NOT_FOUND` rather than a misclassified pipeline failure.

  No host change is required, and the meta tool block stays byte-stable across mounts (`AS-META-005`). Calls that were already well-formed behave identically; malformed ones that used to fail as `EXECUTION_FAILED` now fail as `INVALID_INPUT`, and some that used to fail now succeed. `AS-META-002` (a disjoint scope returns an empty surface) is untouched.

  The `core` size budget moves 18.5 → 19.5 kB (measured 18.86 kB). About 530 B is the envelope check shared by the three verbs plus the repair and its error strings; the model-facing descriptions were trimmed first, since those bytes are re-billed in every request carrying the tool block while the validator is paid once. This is the deliberate revision [02 §budgets](https://github.com/Wiseair-srl/agent-surface/blob/9c8271a/docs/02-architecture.md#bundle-and-performance-budgets-first-measured-baselines) asks for, not drift.

### Patch Changes

- 1dc09ad: `decodeWireName` no longer refuses a capability for having a segment named `at` or `0` (`AS-ID-004`, `AS-WIRE-007`).

  ```ts
  decodeWireName(encodeWireName("view:at.a.a"));
  // before → undefined
  // after  → "view:at.a.a"
  ```

  `view:at.a.a` encodes to `view_at__a__a`, which _contains_ `_at_` — the plane separator meeting a segment named `at`. The decoder screened for that substring to refuse `_at_<instanceId>` names, so every id with an `at` or `0` segment lost its own faithful encoding. A host consulting `toolset.wireNameMap()` was unaffected (it is authoritative, and always has been); a host falling back to `decodeWireName` got `undefined` for a name that reverses perfectly.

  The property suite found it on a random seed rather than a report — `{ seed: 654467906 }`, shrunk to `view:at.a.a` — which is what a randomly-seeded property test is for, and why this surfaced as a red build on `main`.

  **Refusal is now structural.** Three checks decide, and they still refuse every marker-bearing name — including hand-built ones and names an older release emitted:

  - every underscore run in the name is exactly two (one `.`);
  - no decoded segment is empty;
  - the id re-encodes byte-identically.

  **One real ambiguity was found underneath, and closed at the encoder.** `domain:` paths are opaque, so a path may carry a literal `_` — and then `domain:readState__0` and `domain:readState.0` both produce `domain_readState__0`. The substring screen was hiding some of those collisions by accident and missing others: `domain_readState__0` decoded to the wrong id in 0.5 and earlier. An id containing `_` is now **hashed instead of encoded faithfully**, which is the existing "not decodable — consult `wireNameMap()`" path rather than a new contract. Injectivity is now a property of what the encoder emits.

  Wire names change for `domain:` ids whose path contains `_` — they become hashed (`…_0_<hash>`) instead of a faithful encoding that was ambiguous. View ids cannot contain `_` (the grammar forbids it), so no view capability's name changes. `wireNameMap()` resolves both forms as before, and the 64-character budget (`AS-WIRE-004`) and cross-catalog uniqueness (`AS-WIRE-006`) are unchanged.

  Verified by a 300k-case fuzz over an alphabet built to break it (underscores, empty segments, marker lookalikes, per-instance and shortened forms): no wrong decode, no faithful encoding refused, no per-instance or shortened name decoded, every emitted name inside the alphabet and budget.

## 0.5.0

### Minor Changes

- f688924: **Breaking.** The D28 compatibility flags are removed rather than flipped. There is now one way to compose a tool description, and it is the split one.

  ```diff
    const toolset = createAgentToolset(registry, {
      consumer,
      topology: "embedded",
  -   descriptionIncludesState: false,   // no longer an option — this is the behavior
    });

  - createAgentSurfaceRegistry({ snapshotMergesContextualNote: false });
  + createAgentSurfaceRegistry({});
  ```

  Removed: `AgentToolsetOptions.descriptionIncludesState`, `RegistryOptions.snapshotMergesContextualNote`, and `stableDescriptionOf` — the last existed only to recover a note-free description across the two modes, and `description` now _is_ that string.

  **What changes if you set neither flag** (i.e. you were on the defaults): `AgentTool.description` no longer contains `[currently unavailable: …]` or the binding's contextual note, and `AgentProcedureDescriptor.description` no longer has the note folded in. Both signals are still there as data — `AgentTool.state {available, unavailableReason?, note?}` and `AgentProcedureDescriptor.contextualNote` — and **you must render them somewhere the model reads**, or it will plan steps it cannot take. [09 §rendering-capability-state](https://github.com/Wiseair-srl/agent-surface/blob/main/docs/09-adapters.md#rendering-capability-state) has the trailing-block pattern.

  **Why removal instead of the planned flip.** [19 §C4](https://github.com/Wiseair-srl/agent-surface/blob/9c8271a/docs/project/19-catalog-scale-rfc.md) scheduled the flags for one minor: introduce, flip, remove. D28 landed in 0.3 rather than the 0.2 the RFC was written against, and 0.4 shipped without the flip, so they had already run three minors on 0.1 behavior. Pre-1.0, two code paths for one composition were carrying a migration nobody had asked for. Flipping first would have bought a second breaking change one minor later for the same hosts.

  Also: `core` drops to **18.12 kB** and its size budget is retightened 19 → 18.5 kB.

## 0.4.1

### Patch Changes

- f897b7c: Documentation truth pass after 0.4.0. No behavior change in any package.

  0.4.0 shipped D31 alone, which left several published statements false:

  - **`descriptionIncludesState` and `snapshotMergesContextualNote` JSDoc** said the `true` default lasts "for one minor". It has now lasted three (0.2, 0.3, 0.4). This text ships in the `.d.ts`, so hosts read it in their editor — it now says "default through 0.4; flips in 0.5".
  - **[19 §C4](https://github.com/Wiseair-srl/agent-surface/blob/9c8271a/docs/project/19-catalog-scale-rfc.md)** scheduled the D28 flags as introduce-0.2 → flip-0.3 → remove-0.4. D28 landed in 0.3, and 0.4 shipped without the flip, so the live schedule is **flip in 0.5, remove in 0.6**. The accepted RFC answer is annotated rather than rewritten; the record of what was decided stays intact.
  - **[02 §budgets](https://github.com/Wiseair-srl/agent-surface/blob/9c8271a/docs/02-architecture.md#bundle-and-performance-budgets-first-measured-baselines)** claimed the 19 kB `core` budget returns at 0.5. Removal is 0.6, and flipping a default frees nothing regardless — both branches stay in the bundle while the flags exist.
  - **README and [12](https://github.com/Wiseair-srl/agent-surface/blob/9c8271a/docs/project/12-roadmap.md)** still described 0.4 as the unshipped "adoption and enforcement" milestone and pinned the packages at 0.3.0. v0.4 is recut as shipped; the enforcement work moves to v0.5.

  The D28 default flip is **not** in this release — it is a deliberate breaking change for any host that sets neither flag, and it needs a migration note rather than a patch bump.

## 0.4.0

### Minor Changes

- 3588342: Release all packages together at 0.4.0.

  The discovery-honesty changes (D31) land in `core` only, but the packages ship in lockstep while we are pre-1.0 — see `.changeset/README.md`. The `AgentSurfaceSnapshot` shape is what every adapter reads, so a version that identifies the whole surface contract is more useful than four packages trailing a minor behind it.

- 3588342: Meta mode tells the model what it was refused and what its parameters mean (D31, `AS-META-006`).

  **A refused scope is now marked.** `surface_discover` sets `scopeRejected: {prefixes}` on the requested prefixes the configured floor admitted nothing for:

  ```ts
  // floor: ["devices"]
  await surface_discover({ scope: ["billing"] });
  // → { components: [], scopeRejected: { prefixes: ["billing"] }, … }
  ```

  Previously that payload was indistinguishable from an empty surface — same shape, same empty arrays, no marker — and the two call for opposite next moves: ask again unscoped, versus stop asking. This is the rule `AS-META-003` already applies to budget truncation ("the marker travels in the payload the model reads"), applied to the other way a payload can come back smaller than requested. Partial refusals are reported too, so an admitted half returning results is no longer read as evidence the other half was empty.

  The marker is **adapter-produced**: `snapshot()` never sets it, having no scope floor to intersect a request against. A prefix _broader_ than the floor is not a refusal — it collapses to the floor's own prefix, which is D27's narrowing working as specified.

  **The three meta verbs now describe their parameters.** `scope`, `capabilityId`, `instanceId`, `input`, `invocationId`, `confirmationId` and `surfaceVersion` carried no `description`, so a model had to infer from the names alone where each value comes from — while `surface_act`'s _tool_ description carries normative guidance that `AS-META-004` depends on. `scope` is described rather than enumerated deliberately: valid tokens are live component types, and inlining them would make the tool block change on every mount, which is what `AS-META-005` and D28 exist to prevent. The description points at `components[].type` in a previous payload instead.

  Additive in both cases — no host or adapter change is required, and tool-block size stays invariant in the catalog. One related fix: a disjoint scope combined with a `budget` no longer reports the budget's `truncated` count, which was computed against a surface the payload does not contain.

  The `core` size budget moves 18 → 19 kB (measured 18.33 kB). The descriptions are the change, so this is the deliberate revision [02 §budgets](https://github.com/Wiseair-srl/agent-surface/blob/9c8271a/docs/02-architecture.md#bundle-and-performance-budgets-first-measured-baselines) asked for rather than drift. It is not temporary: the D28 default flip frees no bytes, and the compatibility branches only leave in 0.5.

## 0.3.0

### Minor Changes

- 7d8644e: Catalog scale (docs/19, D28–D30) — raised by the first host driving the library at ~300 capabilities per route.

  **Capability state is structured data, not description text (D28).** `AgentTool` gains `state: {available, unavailableReason?, note?}`, and `AgentProcedureDescriptor` gains `contextualNote`. Tool definitions sit at the front of a provider's cached prompt prefix, so folding `available` into `description` meant every user click invalidated the whole conversation behind it — the reporting host measured ~21k tokens per step re-billed at full rate. Both layers keep 0.1's exact output behind compatibility flags for one minor:

  ```ts
  const toolset = createAgentToolset(registry, {
    consumer,
    topology: "embedded",
    descriptionIncludesState: false, // stable tool block; render `state` yourself
  });
  createAgentSurfaceRegistry({ snapshotMergesContextualNote: false }); // for direct snapshot readers
  ```

  `state` and `contextualNote` are populated either way, so you can migrate before the defaults move in 0.3. **If you opt in, render `state` somewhere the model reads it** — the `[currently unavailable: …]` signal is planning fuel, and it is gone from the description (docs/09 §rendering-capability-state has the trailing-state-block pattern).

  **`mode: "meta"` is supported, no longer Experimental (D29).** It graduated on `AS-META-001…005`, which pin scope-as-a-floor, disjoint-scope emptiness, truncation marking, direct-mode confirmation/staleness parity, and constant tool-block size. Graduating it added one thing: `surface_act` now accepts `surfaceVersion`. Echo the value from `surface_discover` on destructive calls — a direct tool carries its catalog's version, so without an echoed token the staleness guard could never fire in meta mode. docs/09 §choosing-a-mode has the selection guide (direct under ~100 per route, scoped direct to ~200, meta beyond).

  **Wire names are collision-checked and reversible only through the map (D30).** Names were already capped at 64 characters; what was missing is that nothing checked for collisions across an emitted catalog, and `decodeWireName` returned a _plausible wrong id_ for shortened and `_at_<instance>` names — silently degrading the canonical id, which is the audit identity. Now:

  ```ts
  const canonicalId = toolset.wireNameMap().get(toolCall.name);
  ```

  `decodeWireName` returns `undefined` for anything it cannot re-encode byte-identically. **Breaking for hosts that reversed names by string surgery**, and shortened names change format (a `_0_` marker before the hash) so refusal is possible at all — this only affects capabilities whose encoding already exceeded 64 characters. `assignWireNames(entries)` is exported for adapters that build their own catalogs.

  Also: `buildDirectTools` no longer re-filters the component array per component (O(n²) in the per-step projection path — ~90k comparisons at 300 mounted components); `stableDescriptionOf(descriptor)` recovers the note-free description in either merge mode.

- 7d8644e: Release all packages together at 0.3.0.

  The catalog-scale corrections (D28–D30) land in `core` only, but the packages ship in lockstep while we are pre-1.0 — see `.changeset/README.md`. Adapters and hosts read the same `AgentTool` shape, so a version that identifies the whole surface contract is more useful than four packages trailing a patch behind it.

## 0.2.0

### Minor Changes

- df7663f: Implement configurable concurrency groups (D25, `AS-CONC-001` — the last requirement still marked `specified`).

  ```ts
  action({ /* … */ concurrency: { mode: "capability" } });
  ```

  - `AgentConcurrency = {mode:"instance"} | {mode:"capability"} | {mode:"key";key} | {mode:"parallel";max}`, each with an optional per-group `queueDepth`.
  - Default is unchanged: `{mode:"instance"}`, one FIFO queue per registration.
  - `parallel` requires an integer `max ≥ 1`; invalid groups throw `AgentSurfaceDefinitionError` at registration rather than degrading at runtime.
  - Groups are created on demand and dropped when idle, so the runtime holds one entry per currently contended group.
  - **Behavior change:** procedure references are now admitted through one group per procedure identity per referencing registration. Repeat calls of the same domain operation serialize client-side where they previously ran unbounded-parallel; a view action on the same component is never blocked by an in-flight domain call. Opt out with an explicit `concurrency` on the binding.

- 24a991b: Release all packages together at 0.2.0.

  `@agent-surface/orpc` and `@agent-surface/testing` now declare their `@agent-surface/react` peer as `>=0.1.0` rather than `workspace:^`. The caret range pinned the minor while React-side packages are still `0.x`, so every sibling minor read as a peer-range break — which is not what the constraint was ever meant to say. The packages are released in lockstep; the peer range now reflects that instead of forcing a major bump on packages whose own API did not change.

- e54f566: Meta-tools mode (Experimental) now honors the direct-mode contract.

  - `surface_read` no longer sends an empty `registrationId` when a target is not uniquely resolvable. An ambiguous read returned `STALE_CAPABILITY {retry:"after-refresh"}`, which sent agents into a refresh loop against an unchanged surface; it now returns `AMBIGUOUS_INSTANCE` with the instance list, matching `surface_act` and direct tools (`AS-ADAPTER-004`).
  - `surface_act` runs through the same invoke helper as direct tools, so staleness binding and the wait-mode confirmation retry no longer diverge.
  - **Behavior change:** the adapter-configured `scope` is now a floor (D27, `AS-ADAPTER-005`). A model-supplied `surface_discover({scope})` may only narrow it; `scope: []` is treated as "unspecified" rather than "everything", and a request outside the floor returns an empty surface. Previously the model's value replaced the configured one, so a scoped adapter could be widened back by asking. Callers relying on the old widening must raise the configured `scope` instead.
  - New `budget` option, `mode:"meta"` only — it truncates `surface_discover` and the `truncated` marker rides in the payload the model reads. Passing it with `mode:"direct"` now throws instead of silently dropping tools.
  - `toolset.subscribe` is documented as never firing in meta mode: the three-tool catalog is constant, and agents re-discover by comparing `surfaceVersion`.
