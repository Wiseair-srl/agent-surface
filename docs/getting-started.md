# Getting started

This guide exposes one React component, installs the compiler authority, and adds the contract check used in CI.

## 1. Install

```bash
pnpm add @agent-surface/core @agent-surface/react
pnpm add -D @agent-surface/compiler @agent-surface/cli
```

Requirements: Node.js 20.19 or newer, Vite, and React 18.2 or newer.

## 2. Add the compiler

```ts
// vite.config.ts
import { agentSurface } from "@agent-surface/compiler";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [agentSurface()],
});
```

The plugin reads Vite's resolved production graph. A contract that is dynamic, unsupported, or not serializable fails the build instead of producing an incomplete manifest.

Declare the virtual module for TypeScript:

```ts
// src/vite-env.d.ts
/// <reference types="vite/client" />

declare module "virtual:agent-surface-contract" {
  import type {
    CapabilityAuthority,
    CapabilityContractManifest,
  } from "@agent-surface/core";

  const authority: CapabilityAuthority;
  export const manifest: CapabilityContractManifest;
  export default authority;
}
```

## 3. Declare a component contract

```tsx
// Counter.tsx
import {
  actionContract,
  defineAgentComponentContract,
  emptyObjectSchema,
  fromJsonSchema,
  observationContract,
} from "@agent-surface/core";
import { useAgentComponent } from "@agent-surface/react";
import { useState } from "react";

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
    increment: actionContract({
      description: "Increment once",
      input: emptyObjectSchema,
      effect: "local-state",
    }),
  },
});

export function Counter() {
  const [value, setValue] = useState(0);

  useAgentComponent(counterContract, {
    observations: { value: { read: () => value } },
    actions: {
      increment: { execute: () => setValue((current) => current + 1) },
    },
  });

  return <button onClick={() => setValue((current) => current + 1)}>{value}</button>;
}
```

The contract contains only static, reviewable semantics: identity, descriptions, schemas, effects, confirmation, tags, and policy attachments. The binding contains live behavior: handlers, state, availability, preconditions, bound values, and instance identity.

## 4. Install the runtime authority

Create one registry for the application and pass it through the React provider:

```tsx
// main.tsx
import authority from "virtual:agent-surface-contract";
import { createAgentSurfaceRegistry } from "@agent-surface/core";
import { AgentSurfaceProvider } from "@agent-surface/react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

const registry = createAgentSurfaceRegistry({ authority });

createRoot(document.getElementById("root")!).render(
  <AgentSurfaceProvider registry={registry}>
    <App />
  </AgentSurfaceProvider>,
);
```

The virtual module and runtime registry are generated from the same manifest. Registry construction, binding registration, and tool exposure all verify that authority.

## 5. Inspect and commit the contract

```bash
pnpm exec agent-surface inspect
pnpm exec agent-surface snapshot
git add .agent-surface/contract.json
```

The snapshot is generated output. Review it like an API or permissions manifest; do not edit it by hand.

Add a CI check:

```bash
pnpm exec agent-surface check --base origin/main --format github
```

The command checks both current source-to-snapshot integrity and contract drift against the Git base.

## Next steps

- [Concepts](01-concepts.md): capabilities, planes, effects, availability, identity.
- [Architecture](02-architecture.md): compiler authority and invocation flow.
- [React API](04-react-api.md): lifecycle and binding behavior.
- [Policies and security](06-policies-and-security.md): authorization and confirmation.
- [Testing](08-testing.md): deterministic tests without an LLM.
- [CLI](20-cli.md): snapshot and CI behavior.
