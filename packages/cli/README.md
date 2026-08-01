# @agent-surface/cli

Inspect and check the agent surface your app exposes — from a terminal, and in CI. Part of [agent-surface](https://github.com/Wiseair-srl/agent-surface).

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
import { createApp } from "./src/agent/setup.js";   // already exists
import { App } from "./src/app/App.js";             // already exists

export default defineSurface({
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
agent-surface inspect [scenario]    # what an agent can see right now
agent-surface snapshot [scenario]   # write/refresh the committed baseline
agent-surface check [scenario]      # exit non-zero when the surface drifts
```

Every command covers all scenarios in the config unless you name one. `inspect` prints each in turn:

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

scenario anonymous  route /devices
0 callable, 0 visible-disabled

Nothing is registered for this scenario — the agent has no surface here.
Re-run with --explain to see whether a policy hid it.
```

### Why is my capability missing?

`snapshot()` bakes policy outcomes: a `hide` removes the capability *and* the reason, because the existence of a hidden capability is itself information. Correct at the agent boundary, useless when you are the developer. `--explain` answers it:

```bash
agent-surface inspect anonymous --explain
```

```text
0 callable, 0 visible-disabled, 11 hidden

hidden by policy (absent from the snapshot)  (11)
  - set  [devices.filters@default]
       Update one or both filters; omitted fields are unchanged.
       policy authenticated (registry, discovery/authorize): hide
```

Every policy in the chain, in the order it runs, with its own vote, the layer it came from, and whether its `onDiscovery` threw. Availability is reported apart from the policy votes — *authority hides, state discloses*, and the two failures must never look alike.

### The scenarios are not a fixture

The same definitions drive your test suite, so "admin on /devices" exists once rather than twice:

```ts
import config from "../agent-surface.config.js";
import { mountScenario } from "@agent-surface/cli/vitest";

const { surface, app } = await mountScenario(config, "admin");
expect(surface).toExpose("view:devices.filters.set");
```

## Notes

Requires `@testing-library/react` and `react-dom` (peers) — it mounts your real tree in jsdom. Anything needing a real browser is out of reach by construction. Output falls back to plain text when piped, or under `--plain`, `CI` and `NO_COLOR`.

Full specification: [docs/20](https://github.com/Wiseair-srl/agent-surface/blob/main/docs/20-cli.md).

MIT © Wiseair S.r.l.
