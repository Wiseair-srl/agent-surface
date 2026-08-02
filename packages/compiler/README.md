# `@agent-surface/compiler`

Vite/Rollup compiler for canonical agent capability contracts.

```ts
import { agentSurface } from "@agent-surface/compiler";

export default defineConfig({ plugins: [agentSurface()] });
```

It traverses the actual production graph, including static/lazy chunks and virtual modules; composes pinned sidecars; emits `agent-surface.contract.json`; injects runtime provenance; and provides `virtual:agent-surface-contract`.
