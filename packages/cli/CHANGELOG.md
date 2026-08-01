# @agent-surface/cli

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
