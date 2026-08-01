# @agent-surface/cli

The agent surface your app exposes — from a terminal, and in CI. It answers three questions: *what can an agent do here right now*, *did that change without anyone noticing*, and *did we author something no scenario ever reaches*. Part of [agent-surface](https://github.com/Wiseair-srl/agent-surface).

It is a developer tool: nothing it prints ever reaches a model.

Docs: https://agent-surface-docs.vercel.app/20-cli

## Install

```bash
pnpm add -D @agent-surface/cli
```

## Configure

A presentation surface only exists once components mount — it is a projection of *what is mounted × route × host context × consumer × policy × live `when()`*. So there is nothing static to read, and the CLI mounts your app. It does not re-implement it: the config points at the composition root you already have.

```tsx
// agent-surface.config.tsx
import { defineSurface } from "@agent-surface/cli";
import { agentManifest, createApp } from "./src/agent/setup.js";   // already exists
import { App } from "./src/app/App.js";             // already exists

export default defineSurface({
  manifest: agentManifest,
  mount: ({ user }) => {
    const app = createApp({ environment: "test", user });
    return { registry: app.registry, ui: <App app={app} />, app };
  },
  scenarios: {
    admin:     { user: { id: "u_admin", permissions: ["devices:write"] } },
    anonymous: { user: null },
  },
});
```

Loading goes through vite-node on your own `vite.config.*`, so your aliases, plugins and TSX resolve exactly as they do in dev.

## Use

```bash
agent-surface init                  # read the codebase, then scaffold a config
agent-surface inspect [scenario]    # what an agent can reach, and what it cannot
agent-surface snapshot [scenario]   # write/refresh the committed baseline
agent-surface check [scenario]      # fail drift, gaps, rejections, stale scenarios
```

Every command covers all scenarios in the config unless you name one. `inspect` prints each in turn:

```text
11 authored (upper bound) · 10 call sites across 21 files · 1 domain manifest capability

scenario admin  route /devices
9 callable, 2 visible-disabled, 0 hidden

CAPABILITY                KIND         EFFECT       STATE     FLAGS
app.navigation.goTo       action       navigation   callable  reversible
devices.drawer.open       action       local-state  callable  reversible
devices.drawer.close      action       local-state  disabled  reversible
    ⤷ The drawer is not open
devices.table.sort        action       local-state  callable  idempotent · reversible
devices.disable           procedure    destructive  disabled  confirmation:required · deviceIds bound+locked
    ⤷ Select at least one device first

11 authored · 11 reached · 0 unreached · 1 scenario (admin)
```

Every count names what it is relative to — the scenario always, the scope when one is active. A surface is a projection of one mounted context, never "the app".

`--detail` swaps the table for one paragraph per capability; `--explain` and `--schemas` imply it.

### Depth

A presentation surface has two sources of truth, and `--depth` says how much of each to compute:

| | reads the TypeScript program | mounts the scenarios | answers |
|---|---|---|---|
| `--depth static` | ✔ | — | what this codebase authors |
| `--depth runtime` | — | ✔ | what a mounted scenario surfaces |
| `--depth full` *(default)* | ✔ | ✔ | both, **and the difference between them** |

`full` is the default because a tool that has to be asked for the complete answer mostly gives the incomplete one. `static` needs no scenarios and survives an app that will not mount; `runtime` skips the program boot on a repository wide enough to feel it.

### Why is my capability missing?

`snapshot()` bakes policy outcomes: a `hide` removes the capability *and* the reason, because the existence of a hidden capability is itself information. Correct at the agent boundary, useless when you are the developer. `--explain` answers it:

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

The hidden capabilities themselves print without the flag — signed out, that scenario shows eleven rows marked `hidden` rather than a bare `0 callable`. `--explain` adds the attribution: every policy in the chain, in the order it runs, with its own vote, the layer it came from, and whether its `onDiscovery` threw. Availability is reported apart from the policy votes — *authority hides, state discloses*, and the two failures must never look alike.

### What did we author that no scenario reaches?

A route nobody visits never registers, so it is in no snapshot and drifts against no baseline — invisible to a mount by construction. The static half reads the TypeScript program instead, and the difference is a first-class finding in **every** command:

```text
UNREACHED — authored, and no scenario mounts it  (1)
CAPABILITY                ORIGIN
view:cov.unmounted.toCsv  Unmounted.tsx:26

3 authored · 2 reached · 1 unreached · 1 scenario (default)
```

`inspect` reports it and `snapshot` reports it; **`check` fails on it**. It also fails on an unread call site, because the catalog is `unreached`'s denominator and holes in it make that count a floor rather than an answer — pass `--allow-unresolved` to accept that knowingly, which still prints the gap. Adoption ratchets through a committed `.agent-surface/coverage-allow.json`, whose stale entries fail the command.

If any scenario fails to mount there is **no verdict at all**: that scenario reached nothing, so everything it would have surfaced would read as unreached. The failed scenarios are named instead, and the static half still prints.

### Exit codes

**0** clean · **1** a finding · **2** the command could not run.

`inspect` never exits `1` — it reports, and `check` gates. CI has to be able to tell "the surface changed" from "the tool never loaded the app", because the second one passing silently is how a gate rots.

> Upgrading from 0.10? `capabilities` is now `inspect --depth static`, and `coverage` is folded into `inspect` and `check`. Both were removed rather than aliased; naming either still prints where its answer went.

### The scenarios are not a fixture

The same definitions drive your test suite, so "admin on /devices" exists once rather than twice:

```ts
import config from "../agent-surface.config.js";
import { mountScenario } from "@agent-surface/cli/vitest";

const { surface, app } = await mountScenario(config, "admin");
expect(surface).toExpose("view:devices.filters.set");
```

## Notes

Requires `@testing-library/react` and `react-dom` (peers) — anything that mounts does so in jsdom, so anything needing a real browser is out of reach by construction. `--depth static` and `init` mount nothing at all, and install no DOM.

Output falls back to plain text when piped, or under `--plain`, `CI` and `NO_COLOR`. stdout carries the command's output and nothing else; diagnostics go to stderr.

Full specification: [docs/20](https://github.com/Wiseair-srl/agent-surface/blob/main/docs/20-cli.md).

MIT © Wiseair S.r.l.
