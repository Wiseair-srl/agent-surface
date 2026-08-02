# Getting started

## 1. Install

```bash
pnpm add @agent-surface/core @agent-surface/react
pnpm add -D @agent-surface/compiler @agent-surface/cli
```

## 2. Add the production compiler

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { agentSurface } from "@agent-surface/compiler";

export default defineConfig({ plugins: [agentSurface()] });
```

## 3. Declare static identity; bind runtime behavior

```tsx
import {
  actionContract,
  defineAgentComponentContract,
  fromJsonSchema,
  observationContract,
} from "@agent-surface/core";
import { useAgentComponent } from "@agent-surface/react";

export const counterContract = defineAgentComponentContract({
  type: "demo.counter",
  description: "Counter",
  observations: {
    value: observationContract({
      description: "Current value",
      output: fromJsonSchema<number>({ type: "number" }),
    }),
  },
  actions: {
    increment: actionContract<Record<string, never>>({
      description: "Increment once",
      input: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }),
      effect: "local-state",
    }),
  },
});

function Counter() {
  const [value, setValue] = useState(0);
  useAgentComponent(counterContract, {
    observations: { value: { read: () => value } },
    actions: { increment: { execute: () => setValue((n) => n + 1) } },
  });
  return <button onClick={() => setValue((n) => n + 1)}>{value}</button>;
}
```

Contract fields must be statically serializable. Runtime bindings contain handlers, live state, availability, preconditions and bound values.

## 4. Install the runtime authority

The compiler exposes an immutable authority backed by the same manifest:

```ts
import authority from "virtual:agent-surface-contract";

const registry = createAgentSurfaceRegistry({ authority });
```

Authority is mandatory. Raw, missing, stale, semantically changed or hash-mismatched registrations fail closed.

## 5. Commit and check

```bash
pnpm exec agent-surface snapshot
git add .agent-surface/contract.json
pnpm exec agent-surface check --base origin/main --format github
```

See [CLI](20-cli.md), [Core](03-core-api.md), [React](04-react-api.md), and [Testing](08-testing.md).
