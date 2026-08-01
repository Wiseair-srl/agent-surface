# 20 — CLI (`@agent-surface/cli`)

> [!NOTE]
> **Status: Draft.** The binary is `agent-surface`. It answers two questions from a terminal and from CI: *what can an agent do on this page right now*, and *did that change without anyone noticing*. It is a developer tool — nothing it prints ever reaches a model.

## Why this isn't `--entry ./router.ts`

A server router is a static export, so a server-side tool can import one file and print its inventory. A presentation surface is not: it is a projection of which components are **currently mounted**, on which **route**, for which **host context** and **consumer**, filtered by **policy** and by live **`when()`** state ([03 §snapshot](03-core-api.md#snapshot)). There is nothing static to read — the surface has to be *mounted* before it exists.

So the CLI mounts your app. It does not re-implement it.

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
9 callable, 2 visible-disabled

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

## Output modes

Terminal-aware only when there is a terminal. Piped output, `--plain`, `CI` and `NO_COLOR` all render plain text; `--json` emits data. Plain output is byte-stable across runs (`AS-CLI-003`) — a CLI whose shape changes when redirected is unusable in a build log.

| Flag | Effect |
|---|---|
| `--config <path>` | Config path. Default: nearest `agent-surface.config.*`, searching upward. |
| `--baseline-dir <path>` | Override where baselines live. |
| `--scope <prefix>` | Restrict to a component-type prefix. Repeatable. |
| `--explain` | Policy attribution, hidden capabilities included. |
| `--schemas` | Include input/output JSON Schemas. |
| `--json` | Emit data. Carries `explanation` only with `--explain`. |
| `--plain` | Force plain text. |

`inspect --json` always emits `{ "scenarios": [ { "scenario", "snapshot", "explanation"? } ] }` — one entry per scenario rendered, one element when you named one. One shape either way, so a consumer never branches on how the command was invoked.

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

Not a browser-automation tool, and not an annotation generator. It reads what your components explicitly registered — there is no "expose everything" switch here either ([11 §non-goal 10](11-non-goals.md)). It mounts in jsdom, so anything requiring a real browser (layout, canvas, actual navigation) is out of its reach by construction.
