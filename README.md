# agent-surface

Typed, policy-aware capabilities for agents operating frontend applications.

agent-surface turns statically declared application capabilities into a compiler-verified contract. Runtime state can decide whether a declared capability is mounted, visible, available, or callable. It cannot create new capability identity or governance metadata.

## One authority path

```text
production Vite graph
  → @agent-surface/compiler
  → immutable CapabilityAuthority
  → authorized runtime binding
  → AgentSurfaceRegistry
  → registry-owned tools and adapters
```

Every supported execution path is rooted in one verified authority manifest:

- the compiler derives the canonical contract from the resolved production graph;
- the virtual module exposes the matching immutable authority;
- the registry requires that authority at construction;
- React and oRPC bind live behavior only to compiled contracts;
- the registry verifies manifest membership, hashes, schemas, effects, confirmation, and policy attachments;
- adapters execute through the registry; standalone provider tools require the authority-backed exposure gateway.

Unknown, dynamic, stale, or semantically mismatched capabilities fail closed. The guarantee covers the library's public execution APIs. A host can still bypass the library by calling its own functions or a provider SDK directly, and servers remain authoritative for persistent or domain effects.

## Install

```bash
pnpm add @agent-surface/core @agent-surface/react
pnpm add -D @agent-surface/compiler @agent-surface/cli
```

Add the compiler to Vite:

```ts
// vite.config.ts
import { agentSurface } from "@agent-surface/compiler";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [agentSurface()] });
```

Declare static semantics and bind live behavior:

```tsx
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
    actions: { increment: { execute: () => setValue((n) => n + 1) } },
  });

  return <button onClick={() => setValue((n) => n + 1)}>{value}</button>;
}
```

Create one registry at the application root and provide it to React:

```tsx
import authority from "virtual:agent-surface-contract";
import { createAgentSurfaceRegistry } from "@agent-surface/core";
import { AgentSurfaceProvider } from "@agent-surface/react";
import { createRoot } from "react-dom/client";

const registry = createAgentSurfaceRegistry({ authority });

createRoot(document.getElementById("root")!).render(
  <AgentSurfaceProvider registry={registry}>
    <App />
  </AgentSurfaceProvider>,
);
```

Commit the reviewable contract and check it in CI:

```bash
pnpm exec agent-surface snapshot
git add .agent-surface/contract.json
pnpm exec agent-surface check --base origin/main --format github
```

Continue with the [getting started guide](docs/getting-started.md), [architecture](docs/02-architecture.md), or [runnable example](examples/devices-app).

## Packages

| Package | Purpose |
|---|---|
| `@agent-surface/core` | Contracts, authority, registry, policies, confirmation, invocation, gateway |
| `@agent-surface/compiler` | Vite production-graph compiler and canonical manifest |
| `@agent-surface/react` | React provider and lifecycle-correct runtime bindings |
| `@agent-surface/orpc` | Contextual, authoritative domain procedure bindings |
| `@agent-surface/testing` | Deterministic harness, helpers, and matchers |
| `@agent-surface/webmcp` | WebMCP transport adapter |
| `@agent-surface/cli` | Contract inspection, snapshots, integrity, and PR drift |

## Runtime guarantees

- Static and lazy production modules contribute through Vite's resolved graph.
- Dynamic or non-serializable contract construction fails compilation.
- Dependency and remote contracts are pinned by content-addressed sidecars.
- Registration verifies private compiler proof and current runtime semantics.
- Generated API inventory and packed-artifact checks cover every published boundary.
- Availability and policy are re-evaluated at invocation time.
- Confirmation is single-use and bound to the validated effective input.
- Stale registrations and conflicting invocation identities fail closed.
- Runtime queues, caches, tombstones, and confirmation storage are bounded.

## Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm check:conformance
pnpm check:api-closure
pnpm check:artifact
pnpm publint
pnpm size
pnpm docs:build
```

MIT © Paolo Barbato / Wiseair.
