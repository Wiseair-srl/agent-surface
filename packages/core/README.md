# @agent-surface/core

Framework-agnostic core of [agent-surface](https://github.com/Wiseair-srl/agent-surface): a registry for declaring an explicit, semantic, typed, policy-governed *agent surface* over a frontend — and nothing more. If a component or capability is not explicitly annotated, it does not exist for the agent.

Zero runtime dependencies. Provides: canonical capability ids, the `AgentSchema` layer (Standard Schema + built-in JSON Schema subset validator), component/capability definitions, the registry (registration lifecycle, availability, versioning, staleness), synchronous snapshots, the 9-phase invocation pipeline, composable policies, single-use confirmation evidence, audit sinks, and a provider-neutral toolset projection for embedded agent loops.

## Install

```bash
pnpm add @agent-surface/core
```

## Use

```ts
import {
  createAgentSurfaceRegistry,
  defineAgentComponent,
  observation,
  action,
  fromStandardSchema,
  createAgentToolset,
} from "@agent-surface/core";

const registry = createAgentSurfaceRegistry({
  environment: import.meta.env.DEV ? "development" : "production",
  context: () => ({ user: authStore.user }),
});

registry.register(
  defineAgentComponent({
    type: "devices.table",
    description: "Table of the devices visible on the current page",
    observations: { readState: observation({ /* … */ }) },
    actions: { selectRows: action({ /* … */ }) },
  }),
);

const toolset = createAgentToolset(registry, {
  consumer: { id: "copilot", kind: "embedded" },
});
```

React apps should use [`@agent-surface/react`](https://www.npmjs.com/package/@agent-surface/react) instead of calling `register` directly. Full specification: [docs](https://github.com/Wiseair-srl/agent-surface/tree/main/docs).

MIT © Wiseair S.r.l.
