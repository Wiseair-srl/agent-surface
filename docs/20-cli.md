# 20 — CLI (`@agent-surface/cli`)

> [!NOTE]
> **Status: Draft.** The binary is `agent-surface`. It shows you the agent surface your app exposes, and fails the build when that surface changes without review. It is a developer tool — nothing it prints ever reaches a model.

## Four commands

| Question | Command |
|---|---|
| I have no config yet. | [`init`](#init) |
| What can an agent reach here, and what can't it? | [`inspect`](#inspect) |
| Accept the current surface as the reviewed one. | [`snapshot`](#snapshot) |
| Fail the build if either changed. | [`check`](#check) |

```bash
agent-surface init                  # read the codebase, then scaffold a config
agent-surface inspect [scenario]    # what an agent can reach, and what it cannot
agent-surface snapshot [scenario]   # write/refresh the committed baseline
agent-surface check [scenario]      # fail on drift, or on a capability no scenario reaches
```

## Two sources of truth

Your app's agent surface is described in two places, and the CLI reads both.

**The catalog — what your code authors.** Registration call sites are static text:

```tsx
useAgentComponent({
  type: "devices.table",                  // string literal
  actions: { sort: action({ … }) },       // capability name is an object key
});
```

`view:devices.table.sort` is fully determined by source. So the catalog is readable from the TypeScript program alone — no server, no jsdom, no mount, no scenarios. The one dynamic part of that call site is `instanceId`, which is not part of a capability id.

**The projection — what a mounted scenario surfaces.** Availability, policy outcome and binding are functions of unbounded application state: which components are **currently mounted**, on which **route**, for which **host context** and **consumer**, filtered by **policy** and by live **`when()`** state ([Core API §snapshot](03-core-api.md#snapshot)). None of that is in the source text. To see it, the CLI mounts your app — it does not re-implement it.

**The difference between them is a finding.** A route no scenario visits, a drawer no scenario opens, a list no scenario fills: those components never register, so they appear in no snapshot, no explanation and no baseline. Reading the catalog is the only way to know they exist. `check` fails on them.

[`--depth`](#depth) says which of the two to compute. Every command computes both by default.

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

### One definition, shared with your tests

The same scenarios drive your test suite:

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

#### What prints, and when

Three things print, and when each prints is a consequence of when it is knowable:

1. **The catalog summary**, first — it is ready before anything mounts.
2. **Each scenario, as it finishes.** A config with ten scenarios is otherwise ten mounts of blank terminal.
3. **The verdict**, last. It is the only part that needs every scenario to have finished, and a reader who stops at the bottom should stop on the finding.

[`check`](#check) inverts this: it collects everything and leads with its findings, because its output is a report someone reads top-down in a pull request rather than a terminal filling up.

#### The table

One capability per line, because *what is on this surface* is a scanning question and prose does not scan. Column widths come from the **content**, never from `process.stdout.columns` — a table laid out against the terminal it happened to run in is byte-stable (`AS-CLI-003`) only until two people diff the same CI log from different windows.

The unavailability reason is a continuation line rather than a column, so one long sentence cannot set the width of the whole grid.

`--detail` restores the grouped, one-paragraph-per-capability view. `--explain` and `--schemas` imply it: policy chains and JSON Schemas are multi-line by nature and cannot live in a cell, so asking for either is asking for the view that can hold them.

#### The header says what the counts are relative to

Every number here is relative to something, and `AS-CLI-007` requires the qualifier to be on screen with it.

- **The scenario**, always — a surface is a projection of one mounted context, never "the app".
- **The scope**, when one is active. `scope` in the config or `--scope` on the command line filters the snapshot *and* the explanation; an unqualified `7 callable` then reads as a claim about the whole surface when it is a claim about one prefix of it. The header prints `scope devices` alongside the route, and the verdict line repeats it.
- **`hidden`, unconditionally — and the hidden capabilities with it.** Signed out, the example app's surface is eleven capabilities that authority hid. Printing only `0 callable, 0 visible-disabled` would render that as an app which annotated nothing, so the rows print too, each marked `hidden`. The explanation is collected on every run, so this costs nothing. The policy *attribution* is what needs `--explain`.

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

So a copy-pasted component `type`, or two instances rendered without an `instanceId`, would otherwise remove a capability with no output anywhere. The collector reads the registry's `component-rejected` events to catch it. `--json` carries `rejections` as an always-present array, so a consumer never has to tell "none" apart from "this CLI is too old to say".

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

The gap leads and drift follows, because a capability nothing reaches is a bigger problem than a capability that changed.

Any difference counts as drift, including a description edit. Descriptions are the provider's cached prompt prefix (D28) — a silent edit re-bills every conversation, which is precisely a change a reviewer should see.

`check` is **always plain**, with no rendering framework in its path at all. Its output is a report pasted into a pull request and read out of a CI log, and neither of those is a terminal.

A green `check` names what it compared, for the same reason the `inspect` header does (`AS-CLI-007`):

```text
3 authored · 3 reached · 0 unreached · 2 scenarios (admin, anonymous)
every authored capability is reached by a scenario

surface matches the baseline in admin, anonymous
```

At `--depth full` that is the whole answer. At `--depth runtime` the catalog was not read, so the line adds that this is a statement about *these scenarios only* — printed exactly where it is true.

#### Exit codes are the contract

`AS-CLI-002`: **`0`** clean · **`1`** a finding · **`2`** the command could not run.

`2` means *could not run*, not merely *bad flag*: an unknown scenario, an unreadable config, a bad `--depth`, or a scenario whose mount threw. A gate that answers `1` both when the surface changed and when the tool never loaded the app is a gate whose red says nothing — CI has to tell those apart, because the second one passing silently is how a gate rots. Same meaning as [`orpc-agent`](https://orpc-agent.dev)'s.

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

Identity and authored metadata come from source text; availability, policy outcome and binding are not claimed here — see [§two sources of truth](#two-sources-of-truth).

Each entry carries how much of its call site was understood:

| `resolution` | Meaning |
|---|---|
| `static` | Identity and metadata both recovered from literals. |
| `partial` | Identity resolved, some metadata dynamic. The common case: a spread `instanceId`, or a description built from a template. |
| `unresolved` | Identity **not** resolved, or members that cannot be enumerated. Reported with its file, line and the construct that defeated the extractor — never dropped. |

#### A spread has to prove it is harmless

A spread in the descriptor can carry `observations` or `actions`, and those capabilities are then beyond this program's reach:

```tsx
useAgentComponent({ type: "repro.spread", ...buildMembers() });   // unread
```

So the extractor resolves what the spread *can* contribute. When the key set is written out and holds no capability group, it stays quiet — that is the shape every example uses, and flagging it would flood the common case:

```tsx
...(props.instance ? { instanceId: props.instance } : {})        // keys: instanceId — quiet
```

When the key set cannot be read, the registration is reported unread, **even if a literal `observations` alongside it resolved perfectly** (`AS-COVER-002`). The half that resolves says nothing about the `actions` the spread may add, and a half read as a whole is the failure this half of the tool exists to prevent.

#### A wrapper hook resolves one hop up

The first thing that happens to a repeated registration is that someone factors it:

```tsx
export function usePanel(type: string) {
  useAgentComponent({ type, observations: { … }, actions: { … } });
}

usePanel("devices.table");     // ← the id lives here
usePanel("billing.invoices");
```

The capability ids are still fully determined by source text — just one frame up. So the extractor follows the wrapper's call sites and emits one capability set per literal, the same one-hop budget it already spends going *sideways* to a same-module `const`, pointed the other way. Both the positional and the destructured spelling (`function useX({ type }: Props)`) are read.

**It resolves a call site only when it can prove that call is this wrapper**: declared in the same file, or imported through a specifier that resolves to the wrapper's own file. Anything else — a re-export chain, a namespace import, a function elsewhere that happens to share the name — stays unread. Attributing the wrong call would put ids in the catalog that no component authors, and a *fabricated* entry is worse than a missing one: every other gap in this tool understates, and that one would overstate.

Resolution is per call site, not per wrapper. Fifteen literals and two variables give fifteen capabilities and one unread line naming the two, which is a truer catalog than seventeen unread lines:

```text
`type` is a parameter of usePanel(); 15 call sites resolved, 2 pass a non-literal
```

**`check` exits non-zero when any call site is unread**, unless `--allow-unresolved` is passed (`AS-COVER-003`) — which still prints the gap. `inspect` prints unread call sites just as loudly and exits `0`, because it is a viewer.

*Why this is the substance of the static half:* every number downstream, the `unreached` denominator above all, is only as trustworthy as the extractor's own admission of what it could not read. A partial understanding of a codebase that reports itself as complete is the failure this exists to remove.

Two boundaries the output states outright:

- **The catalog is an upper bound.** A tsconfig's include globs are wider than what a bundle reaches, so a capability in a component no route renders any more is in here. That is dead code — a different finding, not a false positive — and the summary line says `upper bound` in so many words.
- **The `domain:` plane is not analyzed.** Those capabilities come from the oRPC router, which is already a static export ([OQ-1](project/13-open-questions.md#part-b--genuinely-open-questions)). Reporting zero of them would read as *there are none* rather than *nobody looked*.

Analysis is rooted at the surface config's directory. Program files outside it — workspace packages a tsconfig aliases in, typically the library's own source, where `registry.register(definition)` inside `useAgentComponent` reads as an unresolvable call site — are skipped, and the count of them is printed.

`useAgentComponent` and `registry.register` are the shapes the extractor reads. The granular hooks [`useAgentAction`/`useAgentObservation`](04-react-api.md) register through a render-scope link rather than one aggregated descriptor, so the component `type` is not at their call site at all; every such call is reported `unresolved` with a note ([OQ-13](project/13-open-questions.md#part-b--genuinely-open-questions)). That is deliberate: silently ignoring them would make a codebase built on them look fully covered.

### The verdict

Authored, minus reached. Every command reports it (`AS-COVER-007`): it closes `inspect`, leads `check`, and follows the written baselines in `snapshot`.

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

`--scope devices` filters the mount, so it filters the catalog by **the same predicate** — otherwise every `app.navigation` capability reads as one "no scenario mounts", over two that every scenario mounts. The join calls core's own `matchesScope` rather than a second copy, because a second copy drifts and the drift presents as a false finding.

An allowlist entry outside the active scope is judged neither way — not waved through, not stale — and the count of them is printed, so a scoped run never reads as a verdict on the whole allowlist.

#### No verdict over a partial run

If any scenario failed to mount, **there is no verdict at all**. That scenario reached nothing, so every capability it would have surfaced would be reported unreached — a coverage number computed over a partial run is precisely the misleading check this package refuses to emit. What prints instead names the scenarios that threw, and says why the verdict is missing:

```text
DID NOT MOUNT — these scenarios threw, and were skipped  (1)
  broken
      the data layer needs a token this scenario cannot supply

NO COVERAGE VERDICT — a scenario did not mount, so nothing reached anything  (1)
```

The static half still prints, and so does every scenario that *did* mount — one unmountable scenario must not cost you the rest of the answer.

#### The allowlist ratchet

A repository turning this on with 200 unreached capabilities cannot fix them in one pull request, and a check that can only be adopted big-bang is a check that never gets adopted. A committed `.agent-surface/coverage-allow.json` holds capability ids with a reason string:

```json
{
  "view:billing.invoices.table.sort": "legacy billing screen, deleted in Q3"
}
```

Entries listed there do not fail `check`. Entries that are *no longer* unreached **do** fail it, so the list shrinks and cannot silently rot (`AS-COVER-005`) — the same idiom as the baselines `check` already commits.

**Unread call sites ratchet the same way** (`AS-COVER-008`), in `.agent-surface/unresolved-allow.json`:

```json
{
  "src/agent/useRegisteredPanel.tsx#granular-hook": "shared wrapper hook, tracked in OQ-13"
}
```

The key is `file#reason`, and `inspect` prints it under every unread entry so nobody has to guess the format. Neither half of that key is an accident:

- **not the line**, which churns on every edit above the call site — a ratchet that fails because someone added an import is a ratchet people delete;
- **not the note**, which is prose written for a human and gets reworded. The `reason` is a stable code (`dynamic-type`, `spread-members`, `granular-hook`, …); renaming one invalidates committed lists and is a breaking change.

It is coarser than a line: a second call site in the same file failing the *same* way is covered silently. That is the accepted trade — the ratchet's job is "no new *kinds* of unread site", and the blast radius is one file and one construct.

`--allow-unresolved` remains the blanket dial, for a codebase not yet ready to enumerate them. The two compose: the list holds what you have accepted deliberately, the flag covers the rest, and **a stale entry in either list fails through both**, because a ratchet that can rot is not a ratchet.

The unreached allowlist still cannot wave through an unread codebase — that is what the second file is for, and it is a separate, deliberate decision.

There is deliberately no `--fail-on`. A coarse "gate on drift but not coverage" switch would be a third way to say what these two files already say per entry, and the fine-grained ones are the ones that shrink.

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
