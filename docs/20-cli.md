# 20 — CLI (`@agent-surface/cli`)

> [!NOTE]
> **Status: Draft.** The binary is `agent-surface`. It answers three questions from a terminal and from CI: *what can an agent do on this page right now*, *did that change without anyone noticing*, and *did we author something no scenario ever reaches*. It is a developer tool — nothing it prints ever reaches a model.

## Why this isn't `--entry ./router.ts`

A server router is a static export, so a server-side tool can import one file and print its inventory. A presentation **surface** is not: it is a projection of which components are **currently mounted**, on which **route**, for which **host context** and **consumer**, filtered by **policy** and by live **`when()`** state ([03 §snapshot](03-core-api.md#snapshot)). There is nothing static to read — the surface has to be *mounted* before it exists.

So the CLI mounts your app. It does not re-implement it.

### The projection is dynamic; the catalog is not

That argument is about the **projection**, and for a long time this document let it stand for the **catalog** as well. It does not, and the difference is what [`capabilities`](#capabilities) and [`coverage`](#coverage) exist to recover.

Look at a real call site. `type` is a string literal, capability names are object keys, `description` and `effect` are literals — so the identity `view:devices.table.sort` is fully determined by source text. The only dynamic part is `instanceId`, which is not part of a capability id at all. What is genuinely a function of unbounded application state is *availability*, *policy outcome* and *binding*: the projection, exactly as described above.

Inheriting "the catalog is undiscoverable" from "the projection is dynamic" cost one whole class of finding — **authored, but reached by no scenario**. A route no scenario visits, a drawer no scenario opens, a list no scenario fills: the components never register, so there is nothing to snapshot, nothing for `--explain` to iterate, and no baseline entry for `check` to miss. Scenario coverage was not merely unmeasured, it was unmeasurable.

Scenarios remain required, for the projection. What they stop being is the gate on knowing *what exists*.

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

## Commands

### `inspect`

```bash
agent-surface inspect [scenario]
```

Renders the live surface: component groups, and per capability its effect, `idempotent`/`reversible`, confirmation level, bound-and-locked fields, and — when it is not callable — the reason why.

```text
scenario admin  route /devices
9 callable, 2 visible-disabled, 0 hidden

devices.drawer  (3)
  + open   [local-state, reversible]
       Open the detail drawer for a device
  ~ close  [local-state, reversible]
       Close the detail drawer
       reason: The drawer is not open

authoritative (domain)  (1)
  ~ devices.disable  [destructive, confirmation:required, deviceIds bound+locked]
       Disable the given devices
       reason: Select at least one device first
```

Name a scenario to see only that one; a bare `inspect` renders **every** scenario the config defines, in the order they are listed, each mounted and printed before the next is mounted. That matches bare `snapshot` and `check`, which have always covered all of them — a default that showed only the first made what you saw depend on `Object.keys` order, silently.

`AS-CLI-001` pins that the rendered view contains every capability the snapshot contains — a renderer that quietly drops one is worse than no renderer.

#### The header says what the counts are relative to

Every number here is relative to something, and `AS-CLI-007` requires the qualifier to be on screen with it.

- **The scenario**, always — a surface is a projection of one mounted context, never "the app".
- **The scope**, when one is active. `scope` in the config or `--scope` on the command line filters the snapshot *and* the explanation; an unqualified `7 callable` then reads as a claim about the whole surface when it is a claim about one prefix of it. The header prints `scope devices` alongside the route.
- **`hidden`, unconditionally.** It is computed on every run, because the explanation is always collected. Printing it only under `--explain` meant a surface with a policy-hidden half rendered as a complete one: signed out, the example app showed `0 callable, 0 visible-disabled` and the words *nothing is registered* over eleven perfectly good capabilities that authority had hidden. The *attribution* still needs `--explain`; only the count moved.

#### Registrations the registry refused

A rejected registration is the one failure invisible everywhere else (`AS-CLI-006`):

```text
scenario admin  route /devices
9 callable, 2 visible-disabled, 0 hidden, 1 registration rejected

rejected during mount  (1)
  ! devices.table (default)  duplicate — an earlier registration holds this key
```

Duplicate `(type, instanceId)` yields a dead handle, first-wins; an `onRegister` guard rejection does the same. Neither reaches the snapshot (it never registered) nor the explanation (`explainSurface()` iterates *active* registrations), and neither appears as drift in `check`, because the baseline never contained the capability. The only diagnostic core emits goes through `devError`, which prints nothing unless the app was built `environment: "development"` — and [the config shape above](#configuration) builds it with `"test"`.

So: copy-paste a component `type`, or render two instances without an `instanceId`, and a capability used to disappear with no output anywhere. The registry has always emitted `component-rejected`; the collector now reads it. `--json` carries `rejections` as an always-present array, so a consumer never has to tell "none" apart from "this CLI is too old to say".

### Why is my capability missing?

`snapshot()` bakes policy *outcomes*. A `hide` decision removes the capability outright, leaving no trace — correct at the agent boundary, where the existence of a hidden capability is itself information ([06 §hide vs disable](06-policies-and-security.md#hide-vs-disable-d11d12-restated-as-the-policy-authors-rule)), and exactly wrong for the developer whose capability vanished.

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

Writes `.agent-surface/<scenario>.json` — the normalized form, via the same `serializeSurfaceSnapshot` the Vitest matcher uses ([08 §semantic snapshots](08-testing.md)). Commit it.

### `check`

```bash
agent-surface check [scenario]
```

Compares every scenario against its baseline and **exits non-zero on any difference**, naming the capability rather than only a JSON path:

```text
admin: 1 change
  ~ view:devices.table.sort  (components[3].actions[1].description)
      before: Change the table sorting
      after:  Change the table sorting order

surface drift in 1 scenario — review the change, then `agent-surface snapshot` to accept it
```

Any difference, including a description edit. Descriptions are the provider's cached prompt prefix (D28) — a silent edit re-bills every conversation, which is precisely a change a reviewer should see. Exit codes are the contract (`AS-CLI-002`): `0` matched, `1` drift or missing baseline, `2` usage error.

A green `check` names what it compared, for the same reason the `inspect` header does (`AS-CLI-007`):

```text
surface matches the baseline in admin, anonymous
that is a statement about these scenarios only; capabilities no scenario mounts
are `agent-surface coverage`'s question
```

It does **not** mean "the surface did not change". It means "the surface did not change in the scenarios someone wrote" — and the difference between those two sentences is the next two commands.

### `capabilities`

```bash
agent-surface capabilities [--json] [--allow-unresolved]
```

What this codebase *authors*, as opposed to what a scenario happens to mount. **No Vite dev server, no jsdom, no scenarios, no mount** — it reads the TypeScript program and nothing else.

```text
10 authored (upper bound), 10 call sites across 21 files
domain: not analyzed — domain capabilities come from the oRPC router (OQ-1)

    view:app.navigation.goTo
      src/app/AgentNavigation.tsx:25  [action]
      Navigate to a known application page
  ~ view:devices.table.sort
      src/app/DevicesTable.tsx:162  [action]
      Change the table sorting
      partial: the component config spreads another object, so some metadata here may be dynamic
```

A registration call site is far more static than the surface it produces. `type` is a string literal, capability names are object keys, `description` and `effect` are literals — so `view:devices.table.sort` is fully determined by source text. What is genuinely dynamic is *availability*, *policy outcome* and *binding*, and none of that is claimed here.

Each entry carries how much of its call site was understood:

| `resolution` | Meaning |
|---|---|
| `static` | Identity and metadata both recovered from literals. |
| `partial` | Identity resolved, some metadata dynamic. The common case: a spread `instanceId`, or a description built from a template. |
| `unresolved` | Identity **not** resolved. Reported with its file, line and the construct that defeated the extractor — never dropped. |

**The failure discipline is the substance of this command, not a detail.** `capabilities` **exits non-zero** when any entry is unresolved, unless `--allow-unresolved` is passed (`AS-COVER-003`). A partial understanding of the codebase that reports itself as complete is the exact failure this command exists to remove: every number downstream — the coverage denominator above all — is only as trustworthy as the extractor's own admission of what it could not read. Accepting the gap with `--allow-unresolved` still prints it.

Two boundaries the output states rather than assumes:

- **The inventory is an upper bound.** A tsconfig's include globs are wider than what a bundle reaches, so a capability in a component no route renders any more is in here. That is dead code — a different finding, not a false positive — and the summary line says `upper bound` in so many words.
- **The `domain:` plane is not analyzed.** Those capabilities come from the oRPC router, which is already a static export ([OQ-1](13-open-questions.md#part-b--genuinely-open-questions)). Reporting zero of them would read as *there are none* rather than *nobody looked*.

Analysis is rooted at the surface config's directory. Program files outside it — workspace packages a tsconfig aliases in, typically the library's own source, where `registry.register(definition)` inside `useAgentComponent` reads as an unresolvable call site — are skipped, and the count of them is printed.

`useAgentComponent` and `registry.register` are the shapes the extractor reads. The granular hooks [`useAgentAction`/`useAgentObservation`](04-react-api.md) register through a render-scope link rather than one aggregated descriptor, so the component `type` is not at their call site at all; every such call is reported `unresolved` with a note ([OQ-13](13-open-questions.md#part-b--genuinely-open-questions)). That is deliberate: silently ignoring them would make a codebase built on them look fully covered.

### `coverage`

```bash
agent-surface coverage [scenario]
```

The set difference no other command computes: authored, minus reached.

```text
3 authored (upper bound), 2 reached across 1 scenario (default)

unreached  (1)
  view:cov.unmounted.toCsv
       Unmounted.tsx:26 — no scenario mounts it

surface coverage gap in 1 capability — add a scenario, or delete the component
```

It builds the inventory, mounts every scenario exactly as `check` does, and reports three buckets:

| Bucket | Meaning | Verdict |
|---|---|---|
| `unreached` | Authored, surfaced by no scenario. | Gap — the finding this command exists for. |
| `undeclared` | Present at runtime, no static origin: a dynamic registration, or a gap in the extractor. | Reported, does not fail ([OQ-14](13-open-questions.md#part-b--genuinely-open-questions)). |
| `unresolved` | The inventory could not read the call site. | Gap, carried forward from `capabilities`. |

**Reached means present in the explanation, not in the snapshot** (`AS-COVER-004`). A capability a policy hid *was* reached: a scenario mounted it and the policy made a deliberate decision about it, which `inspect --explain` reports in full. Classifying policy-hidden capabilities as unreached would flood the report with the library's own correct behaviour — the example app's `anonymous` scenario alone would contribute eleven false gaps. The union is therefore taken over `explainSurface()` output across scenarios, joined on `capabilityId`, which is instance-independent by construction.

`domain:` capabilities a scenario reaches are held apart from `undeclared` for the same reason the inventory says `not analyzed`: filing them as *no static origin* would report a stated boundary as a defect.

#### The allowlist ratchets, it does not gate

A repository turning this on with 200 unreached capabilities cannot fix them in one pull request, and a check that can only be adopted big-bang is a check that never gets adopted. `coverage` reads a committed `.agent-surface/coverage-allow.json` — capability ids with a reason string:

```json
{
  "view:billing.invoices.table.sort": "legacy billing screen, deleted in Q3"
}
```

Entries listed there do not fail the command. Entries that are *no longer* unreached **do** fail it, so the list shrinks and cannot silently rot (`AS-COVER-005`) — the same idiom as the baselines `check` already commits. The allowlist covers unreached capabilities only; it cannot be used to wave through an unread codebase, because `unresolved` is a separate bucket that still fails.

Exit codes follow `AS-CLI-002`: `0` no gaps, `1` gaps, `2` usage error.

#### What coverage still cannot see

A UI affordance that was **never registered** — a button with no `action` behind it. Nothing in this repository can find it, because there is nothing to find: no capability, no call site, no registration. Human review of the diff remains the only gate, and a green `coverage` must never be read as covering it.

## Output modes

Terminal-aware only when there is a terminal. Piped output, `--plain`, `CI` and `NO_COLOR` all render plain text; `--json` emits data. Plain output is byte-stable across runs (`AS-CLI-003`) — a CLI whose shape changes when redirected is unusable in a build log.

| Flag | Effect |
|---|---|
| `--config <path>` | Config path. Default: nearest `agent-surface.config.*`, searching upward. |
| `--baseline-dir <path>` | Override where baselines live. |
| `--scope <prefix>` | Restrict to a component-type prefix. Repeatable. |
| `--explain` | Policy attribution, hidden capabilities included. |
| `--schemas` | Include input/output JSON Schemas. |
| `--tsconfig <path>` | The tsconfig `capabilities`/`coverage` read. Default: nearest to the config. |
| `--allow-unresolved` | `capabilities`: exit `0` even when a call site could not be read. |
| `--json` | Emit data. Carries `explanation` only with `--explain`. |
| `--plain` | Force plain text. |

`inspect --json` always emits `{ "scenarios": [ { "scenario", "scope"?, "snapshot", "rejections", "explanation"? } ] }` — one entry per scenario rendered, one element when you named one. One shape either way, so a consumer never branches on how the command was invoked.

**stdout is the output; stderr is everything else** (`AS-CLI-004`). Diagnostics never share the stream the command renders into, and that includes diagnostics the *mounted app* produces: a registry built with `environment: "development"` logs an audit trail, and under Node `console.debug` is `console.log`, so an unqualified console sink lands on stdout and `--json` stops parsing. Core's own sink therefore writes to stderr ([06 §audit](06-policies-and-security.md#audit)). An app that logs to stdout itself will still corrupt `--json`, and only the app can fix that.

## Exiting

The command exits when it is done, rather than when Node's event loop happens to drain (`AS-CLI-005`).

The distinction matters because the CLI hosts your application, and applications are not written for one-shot processes. A polling interval, a websocket, an animation loop, or a data layer whose cache timer outlives the render all keep the loop busy after the last scenario has been printed. Left alone, such a command emits its full and correct output, sets a successful exit code, and then sits there — the worst failure to diagnose, because nothing on screen is wrong.

So a finished command is given a moment to end on its own. If it does not, the CLI names what is still running and exits anyway:

```text
agent-surface: the output above is complete, but 5 handle(s) are still open (Timeout) —
something started during the mount is still running, so this command would have waited
instead of exiting. Common causes: a polling interval, a websocket, or a data layer whose
cache timer outlives the render. Exiting 0.
```

A tidy app never sees this: the message is written only when the command genuinely would have waited, so it is a statement about your app, not about the CLI's own teardown. It goes to stderr, and the exit code is the one the command earned — `check` still exits `1` on drift. The report is a courtesy, not a failure; if you would rather the process not hold a timer at all, that is a fix in the app (TanStack Query's `gcTime`, an interval cleared on unmount), not in the config.

## One graph, one React, one core

The mount happens inside the vite-node module graph, not in the CLI's own. Two independent reasons, both silent failures if ignored:

1. **One React.** The app tree resolves React through the app's Vite config. A second copy rendering it throws on the first hook.
2. **One `@agent-surface/core`.** `explainSurface()` reaches the registry through a plain `Symbol` seam, and a symbol equals only itself within one module instance. Load core twice and the seam misses — the CLI would report an empty explanation for a perfectly good registry.

So the snapshot *and* the explanation are computed beside the registry that owns them, and only plain JSON crosses back. `resolve.dedupe` pins `react`, `react-dom` and the core packages.

## What it is not

Not a browser-automation tool, and not an annotation generator. It reads what your components explicitly registered — there is no "expose everything" switch here either ([11 §non-goal 10](11-non-goals.md)). `inspect`, `snapshot`, `check` and `coverage` mount in jsdom, so anything requiring a real browser (layout, canvas, actual navigation) is out of their reach by construction; `capabilities` mounts nothing at all.

**`capabilities` reads code; it does not expose anything.** No DOM scanning, no selector or accessibility-tree identity, no runtime effect of any kind (directive §2.1). It is the tool [11 §non-goal 10](11-non-goals.md) already contemplates — *"If a future DX tool suggests annotations, it outputs code for humans to review, never runtime exposure"* — except that it does not even suggest annotations. It counts the ones that exist. The inventory lives in `@agent-surface/cli`, which no adapter imports and no application ships, and `AS-COVER-006` pins that it is never reachable from the package root adapters import, mirroring `AS-EXPLAIN-004`.
