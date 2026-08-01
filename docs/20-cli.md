# 20 — CLI (`@agent-surface/cli`)

> [!NOTE]
> **Status: Draft.** The binary is `agent-surface`. It answers three questions from a terminal and from CI: *what can an agent do on this page right now*, *did that change without anyone noticing*, and *did we author something no scenario ever reaches*. It is a developer tool — nothing it prints ever reaches a model.

## Why this isn't `--entry ./router.ts`

A server router is a static export, so a server-side tool can import one file and print its catalog. A presentation **surface** is not: it is a projection of which components are **currently mounted**, on which **route**, for which **host context** and **consumer**, filtered by **policy** and by live **`when()`** state ([Core API §snapshot](03-core-api.md#snapshot)). There is nothing static to read — the surface has to be *mounted* before it exists.

So the CLI mounts your app. It does not re-implement it.

### The projection is dynamic; the catalog is not

That argument is about the **projection**, and for a long time this document let it stand for the **catalog** as well. It does not, and the difference is what [`--depth`](#depth) exists to recover.

Look at a real call site. `type` is a string literal, capability names are object keys, `description` and `effect` are literals — so the identity `view:devices.table.sort` is fully determined by source text. The only dynamic part is `instanceId`, which is not part of a capability id at all. What is genuinely a function of unbounded application state is *availability*, *policy outcome* and *binding*: the projection, exactly as described above.

Inheriting "the catalog is undiscoverable" from "the projection is dynamic" cost one whole class of finding — **authored, but reached by no scenario**. A route no scenario visits, a drawer no scenario opens, a list no scenario fills: the components never register, so there is nothing to snapshot, nothing for `--explain` to iterate, and no baseline entry for `check` to miss. Scenario coverage was not merely unmeasured, it was unmeasurable.

Scenarios remain required, for the projection. What they stop being is the gate on knowing *what exists*.

### Two sources of truth, one command each way

Recovering the catalog first arrived as two more commands — `capabilities` read it, `coverage` joined it against a mount — and that was the wrong cut. It split the command surface along an **implementation seam** (*does this boot a TypeScript program? does it need jsdom?*) rather than along the seam of a **question someone actually has**. Nobody wants "the catalog"; they want to know what an agent can reach, and what it can't.

The cost was not aesthetic. `check` gated on drift alone and printed a line telling you that capabilities no scenario mounts were a different command's question — so in CI a whole unreached route sat behind a green tick, and the tool that knew said nothing. A gate that names the check it is *not* performing is a gate with a hole in it.

So there is one command per question, and the depth dial says how much of the answer to compute (D38, 0.11.0):

| Question | Command |
|---|---|
| I have no config yet. | [`init`](#init) |
| What can an agent reach here, and what can't it? | [`inspect`](#inspect) |
| Accept the current surface as the reviewed one. | [`snapshot`](#snapshot) |
| Fail the build if either changed. | [`check`](#check) |

`capabilities` and `coverage` were removed in 0.11 rather than aliased. Naming them still prints where their answer went.

## Configuration

`agent-surface.config.tsx`, next to your app. It points at the composition root you already have:

```tsx
import { defineSurface } from "@agent-surface/cli";
import { createApp } from "./src/agent/setup.js";   // already exists
import { App } from "./src/app/App.js";             // already exists

export default defineSurface({
  mount: ({ user }) => {
    const app = createApp({ environment: "test", user });
    return { registry: app.registry, ui: <App app={app} />, app };
  },
  scenarios: {
    admin:     { user: { id: "u_admin", permissions: ["devices:read", "devices:write"] } },
    anonymous: { user: null },
  },
});
```

| Field | Meaning |
|---|---|
| `mount(props)` | Build the app. Returns `{ registry, ui }`, plus optional `app` — anything your tests want back. |
| `scenarios` | Named prop bundles. Free-form: a user, a route, a feature flag; the CLI never interprets them. |
| `settle(mounted)` | Optional. Extra settling after mount. React effects and pending microtasks are already flushed for you. |
| `consumer` | Consumer identity snapshots are computed for. Default `{id:"cli",kind:"test"}`. |
| `scope` | Component-type prefixes, same meaning as `SnapshotContext.scope`. |
| `baselineDir` | Where baselines live. Default `.agent-surface`, resolved next to the config. |

Loading goes through **vite-node** on your own `vite.config.*`, so your aliases, plugins and TSX resolve exactly as they do in dev. The mount runs inside that same module graph — see [§one graph](#one-graph-one-react-one-core).

### The scenarios are not a fixture

They are the same definition your test suite uses:

```ts
import config from "../agent-surface.config.js";
import { mountScenario } from "@agent-surface/cli/vitest";

const { surface, app } = await mountScenario(config, "admin");
expect(surface).toExpose("view:devices.filters.set");
```

That is the point of a config file rather than a CLI-only fixture. A suite that mounts the app its own way is a second definition of "admin on /devices" that drifts from the one CI checks. In `examples/devices-app` this **replaced** the suite's bespoke `renderApp()` helper — the test got shorter, not longer.

## Depth

`--depth` selects which of the two sources of truth a command computes (`AS-CLI-008`). It applies to `inspect`, `snapshot` and `check` alike.

| | reads the TypeScript program | mounts the scenarios | answers |
|---|---|---|---|
| `--depth static` | ✔ | — | what this codebase authors |
| `--depth runtime` | — | ✔ | what a mounted scenario surfaces |
| `--depth full` *(default)* | ✔ | ✔ | both, **and the difference between them** |

`full` is the default because a tool that has to be asked for the complete answer mostly gives the incomplete one. It costs one TypeScript program boot — under a second on `examples/devices-app`, more on a wide tsconfig, which is what `--depth runtime` is for.

`--depth static` is the only depth that needs no scenarios and survives an app that will not mount: no Vite server, no jsdom, no DOM installed at all. It is also the only depth `check` and `snapshot` refuse, because a baseline is a projection and at that depth nothing is mounted — there is nothing to compare and nothing to write, and saying so beats reporting a vacuous match.

## Commands

### `init`

```bash
agent-surface init [--yes]
```

Reads the codebase, tells you what it found, and only then offers to write `agent-surface.config.tsx`. It mounts nothing and needs no config to exist — it is `--depth static` with a file write on the end.

```text
Read 34 files from tsconfig.json

  authored capabilities   10
  components              4
  unread call sites       0

  app.navigation
  devices.drawer
  devices.filters
  devices.table

Write agent-surface.config.tsx?
  it will import from ./src/main.tsx, which you will still have to wire into a mount()
```

The order is the point: the number it prints is the one every later command is relative to, and a scaffold offered before the summary asks you to accept a config for a codebase neither of you has looked at yet. It writes nothing before the summary, and nothing at all without a `y` (or `--yes`, which is how a non-interactive shell has to answer — there is nobody there to ask).

Unlike `orpc-agent init`, it does not probe an entry module: a surface config needs a `mount()` that builds the app, and there is no export a tool can import to get one. It names the likeliest file and leaves the wiring to you.

### `inspect`

```bash
agent-surface inspect [scenario]
```

The whole surface: what this codebase authors, what a mount surfaces, and the difference.

```text
10 authored (upper bound) · 10 call sites across 21 files · domain not analyzed, it comes from the oRPC router (OQ-1)

scenario admin  route /devices
9 callable, 2 visible-disabled, 0 hidden

CAPABILITY                KIND         EFFECT       STATE     FLAGS
app.navigation.goTo       action       navigation   callable  reversible
devices.drawer.state      observation  —            callable  —
devices.drawer.open       action       local-state  callable  reversible
devices.drawer.close      action       local-state  disabled  reversible
    ⤷ The drawer is not open
devices.table.sort        action       local-state  callable  idempotent · reversible
devices.disable           procedure    destructive  disabled  confirmation:required · deviceIds bound+locked
    ⤷ Select at least one device first

10 authored · 10 reached · 0 unreached · 1 scenario (admin)
```

**It reports findings; it never gates on them.** Exit `0` whatever it prints, because [`check`](#check) is the gate and a viewer that sometimes fails is a viewer nobody puts in a pipeline. The one exception is `2`, which is not a finding — the command could not run.

Name a scenario to see only that one; a bare `inspect` renders **every** scenario the config defines, in the order they are listed. `AS-CLI-001` pins that the rendered view contains every capability the snapshot contains — a renderer that quietly drops one is worse than no renderer.

#### Order is the design

Three things print, and when each prints is a consequence of when it is knowable:

1. **The catalog summary**, first — it is ready before anything mounts.
2. **Each scenario, as it finishes.** A config with ten scenarios is otherwise ten mounts of blank terminal.
3. **The verdict**, last. It is the only part that needs every scenario to have finished, and a reader who stops at the bottom should stop on the finding.

[`check`](#check) inverts this: it collects everything and leads with its findings, because its output is a report someone reads top-down in a pull request rather than a terminal filling up.

#### A table, not paragraphs

One capability per line, because *what is on this surface* is a scanning question and prose does not scan. Column widths come from the **content**, never from `process.stdout.columns` — a table laid out against the terminal it happened to run in is byte-stable (`AS-CLI-003`) only until two people diff the same CI log from different windows.

The unavailability reason is a continuation line rather than a column, so one long sentence cannot set the width of the whole grid.

`--detail` restores the grouped, one-paragraph-per-capability view. `--explain` and `--schemas` imply it: policy chains and JSON Schemas are multi-line by nature and cannot live in a cell, so asking for either is asking for the view that can hold them.

#### The header says what the counts are relative to

Every number here is relative to something, and `AS-CLI-007` requires the qualifier to be on screen with it.

- **The scenario**, always — a surface is a projection of one mounted context, never "the app".
- **The scope**, when one is active. `scope` in the config or `--scope` on the command line filters the snapshot *and* the explanation; an unqualified `7 callable` then reads as a claim about the whole surface when it is a claim about one prefix of it. The header prints `scope devices` alongside the route, and the verdict line repeats it.
- **`hidden`, unconditionally — and the hidden capabilities with it.** The explanation is collected on every run, so both were always computable. Printing them only under `--explain` meant a surface with a policy-hidden half rendered as a complete one: signed out, the example app showed `0 callable, 0 visible-disabled` and the words *nothing is registered* over eleven perfectly good capabilities that authority had hidden. The count moved out from behind the flag first; the rows followed in 0.11, and now that scenario renders eleven lines marked `hidden`. The *attribution* still needs `--explain`.

A hidden row prints **no reason line**. The reason a hidden capability carries is its *availability* reason, and printing "The drawer is not open" under a row marked `hidden` says the UI declined when authority did. Authority hides, state discloses (D11/D12), and the two must never look alike.

#### Registrations the registry refused

A rejected registration is the one failure invisible everywhere else (`AS-CLI-006`):

```text
scenario admin  route /devices
9 callable, 2 visible-disabled, 0 hidden, 1 registration rejected

REJECTED — the registry refused these during the mount  (1)
  ! devices.table (default)  duplicate — an earlier registration holds this key
```

Duplicate `(type, instanceId)` yields a dead handle, first-wins; an `onRegister` guard rejection does the same. Neither reaches the snapshot (it never registered) nor the explanation (`explainSurface()` iterates *active* registrations), and neither appears as drift in `check`, because the baseline never contained the capability. The only diagnostic core emits goes through `devError`, which prints nothing unless the app was built `environment: "development"` — and [the config shape above](#configuration) builds it with `"test"`.

So: copy-paste a component `type`, or render two instances without an `instanceId`, and a capability used to disappear with no output anywhere. The registry has always emitted `component-rejected`; the collector now reads it. `--json` carries `rejections` as an always-present array, so a consumer never has to tell "none" apart from "this CLI is too old to say".

### Why is my capability missing?

`snapshot()` bakes policy *outcomes*. A `hide` decision removes the capability outright, leaving no trace — correct at the agent boundary, where the existence of a hidden capability is itself information ([Policies & Security §hide vs disable](06-policies-and-security.md#hide-vs-disable-d11d12-restated-as-the-policy-authors-rule)), and exactly wrong for the developer whose capability vanished.

`--explain` answers it:

```bash
agent-surface inspect anonymous --explain
```

```text
scenario anonymous  route /devices
0 callable, 0 visible-disabled, 11 hidden

hidden by policy (absent from the snapshot)  (11)
  - set  [devices.filters@default]
      Update one or both filters; omitted fields are unchanged.
      policy authenticated (registry, discovery/authorize): hide
```

Every policy in the chain is listed in the order it runs, with its own vote, the layer it came from (`registry` / `component` / `capability`), the pipeline phases it implements, whether it escalates confirmation, and whether its `onDiscovery` **threw** — a defect `evaluateDiscovery` fails closed on, silently (`AS-EXPLAIN-001`, `AS-EXPLAIN-002`).

Availability is reported separately from policy, because they are different failures: *authority hides, state discloses* (D11/D12). "A policy removed it" and "the UI says not right now" must never look alike.

### `snapshot`

```bash
agent-surface snapshot [scenario]
```

Writes `.agent-surface/<scenario>.json` — the normalized form, via the same `serializeSurfaceSnapshot` the Vitest matcher uses ([Testing §semantic snapshots](08-testing.md)). Commit it.

It prints [the verdict](#the-verdict) too. This is the command you run to *accept* a change to the surface, which makes it the last moment before a reviewer sees the diff — and accepting a projection while a capability sits behind a route no scenario visits is exactly the state worth hearing about. It reports; `check` is still the only thing that fails.

### `check`

```bash
agent-surface check [scenario]
```

The gate — the only command that fails on a finding, which is why every finding has to reach it. It fails on four:

| | |
|---|---|
| **drift** | the surface changed against its committed baseline |
| **no baseline** | nothing to compare, which is not the same as a match |
| **unreached** | authored, and no scenario mounts it |
| **unread call site** | the catalog is incomplete, so `unreached` is a floor rather than an answer |

```text
UNREACHED — authored, and no scenario mounts it  (1)
CAPABILITY                ORIGIN
view:cov.unmounted.toCsv  Unmounted.tsx:26

3 authored · 2 reached · 1 unreached · 1 scenario (default)

DRIFT — the surface changed against its baseline  (1)
  admin: 1 change
    ~ view:devices.table.sort  (components[3].actions[1].description)
        before: Change the table sorting
        after:  Change the table sorting order

surface drift in 1 scenario — review the change, then `agent-surface snapshot` to accept it
```

The gap leads, because it is the finding this command could not previously make at all. Drift follows, because it is the one it always could.

Any difference counts as drift, including a description edit. Descriptions are the provider's cached prompt prefix (D28) — a silent edit re-bills every conversation, which is precisely a change a reviewer should see.

`check` is **always plain**, with no rendering framework in its path at all. Its output is a report pasted into a pull request and read out of a CI log, and neither of those is a terminal.

A green `check` names what it compared, for the same reason the `inspect` header does (`AS-CLI-007`):

```text
3 authored · 3 reached · 0 unreached · 2 scenarios (admin, anonymous)
every authored capability is reached by a scenario

surface matches the baseline in admin, anonymous
```

It used to have to add that this was a statement about *these scenarios only*, and point at another command for the rest. At `--depth full` there is no rest. At `--depth runtime` there is, and the caveat is still printed — exactly where it is still true.

#### Exit codes are the contract

`AS-CLI-002`: **`0`** clean · **`1`** a finding · **`2`** the command could not run.

`2` widened in 0.11 from "usage error" to "could not run at all", matching [`orpc-agent`](https://orpc-agent.dev). It now covers an unknown scenario, an unreadable config, a bad `--depth`, *and* a scenario whose mount threw. A gate that answers `1` both when the surface changed and when the tool never loaded the app is a gate whose red says nothing — CI has to be able to tell those apart, because the second one passing silently is how a gate rots.

### The catalog (`--depth static`)

What this codebase *authors*, as opposed to what a scenario happens to mount. **No Vite dev server, no jsdom, no scenarios, no mount** — it reads the TypeScript program and nothing else.

```bash
agent-surface inspect --depth static
```

```text
10 authored (upper bound) · 10 call sites across 21 files · domain not analyzed, it comes from the oRPC router (OQ-1)
40 program files outside the config's directory were not analyzed

CAPABILITY                KIND    ORIGIN                          READ
view:app.navigation.goTo  action  src/app/AgentNavigation.tsx:25  static
view:devices.table.sort   action  src/app/DevicesTable.tsx:162    partial
    ⤷ the component config spreads another object, so some metadata here may be dynamic
```

At `--depth full` only the summary line prints here: the scenario tables below name every capability a scenario reached, and the verdict names the ones it did not, so the listing would be the same information a second time, above the answer instead of in it.

This works because a registration call site is far more static than the surface it produces — see [§the projection is dynamic; the catalog is not](#the-projection-is-dynamic-the-catalog-is-not). Availability, policy outcome and binding are not claimed here; identity and authored metadata are.

Each entry carries how much of its call site was understood:

| `resolution` | Meaning |
|---|---|
| `static` | Identity and metadata both recovered from literals. |
| `partial` | Identity resolved, some metadata dynamic. The common case: a spread `instanceId`, or a description built from a template. |
| `unresolved` | Identity **not** resolved. Reported with its file, line and the construct that defeated the extractor — never dropped. |

**`check` exits non-zero when any call site is unread**, unless `--allow-unresolved` is passed (`AS-COVER-003`) — which still prints the gap. The exit moved from `capabilities` to `check` in 0.11 along with the command; the discipline did not move, it concentrated. `inspect` prints unread call sites just as loudly and exits `0`, because it is a viewer.

*Why this is the substance of the static half:* every number downstream, the `unreached` denominator above all, is only as trustworthy as the extractor's own admission of what it could not read. A partial understanding of a codebase that reports itself as complete is the failure this exists to remove.

Two boundaries the output states outright:

- **The catalog is an upper bound.** A tsconfig's include globs are wider than what a bundle reaches, so a capability in a component no route renders any more is in here. That is dead code — a different finding, not a false positive — and the summary line says `upper bound` in so many words.
- **The `domain:` plane is not analyzed.** Those capabilities come from the oRPC router, which is already a static export ([OQ-1](project/13-open-questions.md#part-b--genuinely-open-questions)). Reporting zero of them would read as *there are none* rather than *nobody looked*.

Analysis is rooted at the surface config's directory. Program files outside it — workspace packages a tsconfig aliases in, typically the library's own source, where `registry.register(definition)` inside `useAgentComponent` reads as an unresolvable call site — are skipped, and the count of them is printed.

`useAgentComponent` and `registry.register` are the shapes the extractor reads. The granular hooks [`useAgentAction`/`useAgentObservation`](04-react-api.md) register through a render-scope link rather than one aggregated descriptor, so the component `type` is not at their call site at all; every such call is reported `unresolved` with a note ([OQ-13](project/13-open-questions.md#part-b--genuinely-open-questions)). That is deliberate: silently ignoring them would make a codebase built on them look fully covered.

### The verdict

The set difference nothing else computes: authored, minus reached. It closes `inspect` and leads `check`, and `snapshot` prints it too (`AS-COVER-007`) — the finding used to live behind a fifth command, and the whole point of removing that command is that it now reaches every one of them.

```text
UNREACHED — authored, and no scenario mounts it  (1)
CAPABILITY                ORIGIN
view:cov.unmounted.toCsv  Unmounted.tsx:26

3 authored · 2 reached · 1 unreached · 1 scenario (default)
```

Three buckets:

| Bucket | Meaning | Verdict |
|---|---|---|
| `unreached` | Authored, surfaced by no scenario. | Gap — the finding this exists for. |
| `undeclared` | Present at runtime, no static origin: a dynamic registration, or a gap in the extractor. | Reported, does not fail ([OQ-14](project/13-open-questions.md#part-b--genuinely-open-questions)). |
| `unresolved` | The catalog could not read the call site. | Gap. |

**Reached means present in the explanation, not in the snapshot** (`AS-COVER-004`). A capability a policy hid *was* reached: a scenario mounted it and the policy made a deliberate decision about it, which `inspect --explain` reports in full. Classifying policy-hidden capabilities as unreached would flood the report with the library's own correct behaviour — the example app's `anonymous` scenario alone would contribute eleven false gaps. The union is therefore taken over `explainSurface()` output across scenarios, joined on `capabilityId`, which is instance-independent by construction.

`domain:` capabilities a scenario reaches are held apart from `undeclared` for the same reason the catalog says `not analyzed`: filing them as *no static origin* would report a stated boundary as a defect.

#### A scope filters both halves, or neither

`--scope devices` filters the mount. It has to filter the catalog by **the same predicate**, or every `app.navigation` capability is reported as one "no scenario mounts" — over two that every scenario mounts. That was a live defect until 0.11; the join now calls core's own `matchesScope` rather than a second copy of it, because a second copy drifts and the drift presents as a false finding.

An allowlist entry outside the active scope is judged neither way — not waved through, not stale — and the count of them is printed, so a scoped run never reads as a verdict on the whole allowlist.

#### No verdict over a partial run

If any scenario failed to mount, **there is no verdict at all**. That scenario reached nothing, so every capability it would have surfaced would be reported unreached — a coverage number computed over a partial run is precisely the misleading check this package refuses to emit. What prints instead names the scenarios that threw, and says why the verdict is missing:

```text
DID NOT MOUNT — these scenarios threw, and were skipped  (1)
  broken
      the data layer needs a token this scenario cannot supply

NO COVERAGE VERDICT — a scenario did not mount, so nothing reached anything  (1)
```

The static half still prints, and so does every scenario that *did* mount. Before the commands were merged, `capabilities` was the only one that still worked on an app that would not mount; a merged command that let one bad scenario abort the run would have thrown that property away.

#### The allowlist ratchets, it does not gate

A repository turning this on with 200 unreached capabilities cannot fix them in one pull request, and a check that can only be adopted big-bang is a check that never gets adopted. A committed `.agent-surface/coverage-allow.json` holds capability ids with a reason string:

```json
{
  "view:billing.invoices.table.sort": "legacy billing screen, deleted in Q3"
}
```

Entries listed there do not fail `check`. Entries that are *no longer* unreached **do** fail it, so the list shrinks and cannot silently rot (`AS-COVER-005`) — the same idiom as the baselines `check` already commits. The allowlist covers unreached capabilities only; it cannot be used to wave through an unread codebase, because `unresolved` is a separate bucket with its own, separate acceptance in `--allow-unresolved`.

Two buckets, two dials, and deliberately no third: there is no `--fail-on`. A coarse "gate on drift but not coverage" switch would be a second way to say what the allowlist already says per-capability, and the fine-grained one is the one that shrinks.

#### What the verdict still cannot see

A UI affordance that was **never registered** — a button with no `action` behind it. Nothing in this repository can find it, because there is nothing to find: no capability, no call site, no registration. Human review of the diff remains the only gate, and `0 unreached` must never be read as covering it.

## Output modes

Terminal-aware only when there is a terminal. Piped output, `--plain`, `CI` and `NO_COLOR` all render plain text; `--json` emits data. Plain output is byte-stable across runs (`AS-CLI-003`) — a CLI whose shape changes when redirected is unusable in a build log.

| Flag | Effect |
|---|---|
| `--depth static\|runtime\|full` | Which halves to compute. Default `full`. |
| `--config <path>` | Config path. Default: nearest `agent-surface.config.*`, searching upward. |
| `--baseline-dir <path>` | Override where baselines live. |
| `--scope <prefix>` | Restrict to a component-type prefix. Repeatable. |
| `--detail` | One paragraph per capability instead of the table. |
| `--explain` | Policy attribution. Implies `--detail`. |
| `--schemas` | Include input/output JSON Schemas. Implies `--detail`. |
| `--tsconfig <path>` | The tsconfig the static half reads. Default: nearest to the config. |
| `--allow-unresolved` | `check`: do not fail on a call site that could not be read. |
| `--yes` | `init`: write without asking. |
| `--json` | Emit data. Carries `explanation` only with `--explain`. |
| `--plain` | Force plain text. |

`inspect --json` always emits one shape, whatever the depth and whether or not a scenario was named:

```jsonc
{
  "depth": "full",
  "catalog":   { /* … */ } | null,   // null at --depth runtime
  "scenarios": [ { "scenario", "scope"?, "snapshot", "rejections", "explanation"? } ],
  "failures":  [ { "scenario", "message" } ],
  "coverage":  { /* … */ } | null    // null at any depth but full, or after a failed mount
}
```

A half the depth did not compute is `null`, which is a different statement from `[]` or `{}` — a consumer must never have to tell "nothing found" apart from "nobody looked".

**stdout is the output; stderr is everything else** (`AS-CLI-004`) — including diagnostics the *mounted app* produces. Core's audit sink therefore writes to stderr under Node ([Policies & Security §audit](06-policies-and-security.md#audit)).

*Why:* a registry built with `environment: "development"` logs an audit trail, and under Node `console.debug` is `console.log`. An unqualified console sink lands on stdout and `--json` stops parsing. An app that writes to stdout itself will still corrupt `--json`, and only the app can fix that.

## Exiting

**A finished command exits, rather than waiting for Node's event loop to drain** (`AS-CLI-005`). It gets a moment to end on its own; if it does not, the CLI names what is still running and exits anyway, on the exit code the command earned — `check` still exits `1` on drift.

*Why:* the CLI hosts your application, and applications are not written for one-shot processes. A polling interval, a websocket, or a data layer whose cache timer outlives the render keeps the loop busy after the last scenario is printed. Left alone the command emits full, correct output, sets a successful exit code, and then sits there — the worst kind of failure to diagnose, because nothing on screen is wrong.

```text
agent-surface: the output above is complete, but 5 handle(s) are still open (Timeout) —
something started during the mount is still running, so this command would have waited
instead of exiting. Common causes: a polling interval, a websocket, or a data layer whose
cache timer outlives the render. Exiting 0.
```

A tidy app never sees this. The message goes to stderr and is written only when the run genuinely would have waited, so it is a statement about your app, not about the CLI's teardown — a courtesy, not a failure. The fix, if you want one, is in the app: TanStack Query's `gcTime`, an interval cleared on unmount. Not in the config.

## One graph, one React, one core

The mount happens inside the vite-node module graph, not in the CLI's own. Two independent reasons, both silent failures if ignored:

1. **One React.** The app tree resolves React through the app's Vite config. A second copy rendering it throws on the first hook.
2. **One `@agent-surface/core`.** `explainSurface()` reaches the registry through a plain `Symbol` seam, and a symbol equals only itself within one module instance. Load core twice and the seam misses — the CLI would report an empty explanation for a perfectly good registry.

So the snapshot *and* the explanation are computed beside the registry that owns them, and only plain JSON crosses back. `resolve.dedupe` pins `react`, `react-dom` and the core packages.

## What it is not

Not a browser-automation tool, and not an annotation generator. It reads what your components explicitly registered — there is no "expose everything" switch here either ([Non-Goals §10](11-non-goals.md)). Anything that mounts does so in jsdom, so anything requiring a real browser (layout, canvas, actual navigation) is out of reach by construction; `--depth static` mounts nothing at all.

**The static half reads code; it does not expose anything.** No DOM scanning, no selector or accessibility-tree identity, no runtime effect of any kind (directive §2.1). It is the tool [Non-Goals §10](11-non-goals.md) already contemplates — *"If a future DX tool suggests annotations, it outputs code for humans to review, never runtime exposure"* — except that it does not even suggest annotations. It counts the ones that exist. The catalog lives in `@agent-surface/cli`, which no adapter imports and no application ships, and `AS-COVER-006` pins that it is never reachable from the package root adapters import, mirroring `AS-EXPLAIN-004`.
