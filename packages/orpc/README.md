# @agent-surface/orpc

Contextual references to oRPC domain procedures for [agent-surface](https://github.com/Wiseair-srl/agent-surface). A frontend never redefines a domain operation: it **references** one exposed via [orpc-agent](https://orpc-agent.dev) — same identity, same server authority — and adds the three things only the frontend can know: whether it is relevant right now, which inputs come from UI state, and what the user must confirm before it runs.

Docs: https://agent-surface-docs.vercel.app

## Install

```bash
pnpm add @agent-surface/core @agent-surface/orpc
```

## Use

```ts
import { createOrpcAgentBridge } from "@agent-surface/orpc";

export const bridge = createOrpcAgentBridge({
  client: orpcClient,      // the app's existing typed oRPC client
  manifest: agentManifest, // which procedures orpc-agent exposes (the ceiling)
});
registry.setProcedureExecutor(bridge.executor);
```

```tsx
import { useAgentProcedure } from "@agent-surface/orpc/react";

useAgentProcedure(bridge.refs.devices.disable, {
  when: () => selectedIds.length > 0,
  unavailableReason: "Select at least one device first",
  bind: () => ({ deviceIds: selectedIds }), // locked: the agent cannot override it
  confirmation: "required",
});
```

Bound fields are removed from the agent-facing schema and locked by default; `bind()` runs at execution time on live UI state; the merged input is re-validated against the full schema before forwarding; the server re-validates everything regardless.

Full specification: [docs/05](https://github.com/Wiseair-srl/agent-surface/blob/main/docs/05-orpc-integration.md).

MIT © Wiseair S.r.l.
