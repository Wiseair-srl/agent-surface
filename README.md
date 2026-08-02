# agent-surface

Typed, policy-aware capabilities for agents operating application surfaces.

The repository contract is compiler-generated from the real production module graph. Runtime state may decide whether a declared capability is mounted, visible or callable; it cannot mint capability identity or governance metadata.

## Core invariant

Every supported exposed tool carries compiler provenance:

```text
token.manifestHash == runningManifest.hash
token.declarationId exists in runningManifest
token.contractHash matches runningManifest
```

Unknown, raw, stale or mismatched registrations fail closed when the manifest is installed. Provider/MCP tools pass through the same audited exposure gateway.

## Quick start

```bash
pnpm add @agent-surface/core @agent-surface/react
pnpm add -D @agent-surface/compiler @agent-surface/cli
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { agentSurface } from "@agent-surface/compiler";

export default defineConfig({ plugins: [agentSurface()] });
```

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

Install the generated manifest at the production composition root:

```ts
import manifest from "virtual:agent-surface-contract";
import { createAgentSurfaceRegistry } from "@agent-surface/core";

const registry = createAgentSurfaceRegistry({ manifest });
```

Then commit the canonical review artifact:

```bash
pnpm exec agent-surface snapshot
pnpm exec agent-surface check --base origin/main --format github
```

## Packages

| Package | Purpose |
|---|---|
| `@agent-surface/core` | Contracts, registry, policy, confirmation, invocation, gateway |
| `@agent-surface/compiler` | Vite production-graph compiler and canonical manifest |
| `@agent-surface/react` | Lifecycle-correct runtime bindings |
| `@agent-surface/orpc` | Contextual authoritative domain procedure bindings |
| `@agent-surface/testing` | Deterministic runtime harness and matchers |
| `@agent-surface/webmcp` | WebMCP adapter |
| `@agent-surface/cli` | Inspect, snapshot, integrity and PR drift |

## What changed in 0.16

The compiler contract supersedes heuristic extraction and scenario mounts (D40). Removed CLI concepts: config mount functions, scenarios, depth, scope, coverage joins, runtime baselines, unresolved/coverage allowlists, jsdom and `init`.

Static contracts own identity, descriptions, schemas, effects, confirmation, tags and policy attachments. Runtime bindings own handlers, state, availability, bound values and instances.

## Guarantees

- Production static/lazy chunks and virtual modules contribute through Vite’s resolved graph.
- Dynamic or non-serializable contract construction is a compiler error.
- Dependency/remote contracts are content-addressed sidecars.
- A second declaration of the same capability id remains a distinct review row.
- Canonical output is byte-identical across checkout paths.
- `check` separates source/snapshot integrity from snapshot/base PR drift.
- Runtime behavior tests remain useful, but never define repository reach.

## Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm check:conformance
pnpm publint
pnpm size
```

Documentation starts at [docs/index.md](docs/index.md). CLI contract: [docs/20-cli.md](docs/20-cli.md). Example: [examples/devices-app](examples/devices-app).

MIT © Paolo Barbato / Wiseair.
