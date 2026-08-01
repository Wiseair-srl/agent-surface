# @agent-surface/cli

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
