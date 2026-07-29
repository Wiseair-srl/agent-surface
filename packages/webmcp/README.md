# @agent-surface/webmcp

> **Experimental.** The WebMCP (`navigator.modelContext`) surface area, permission model, and lifecycle are unstable; this adapter tracks them and absorbs the drift so nothing WebMCP-shaped leaks into `@agent-surface/core`. The application model stays in agent-surface — WebMCP is strictly transport/discovery.

WebMCP transport adapter for [agent-surface](https://github.com/Wiseair-srl/agent-surface): one wire-named tool per **available** capability, re-provided on every `surface-changed`. Unavailable capabilities are not registered (WebMCP has no disabled state today — the availability reason is lost on this transport; accepted limitation). The user agent is treated as the least-trusted consumer: scope the adapter and keep two-phase confirmations.

Docs: https://agent-surface-docs.vercel.app

## Install

```bash
pnpm add @agent-surface/core @agent-surface/webmcp
```

## Use

```ts
import { createWebMcpAdapter } from "@agent-surface/webmcp";

const adapter = createWebMcpAdapter({
  snapshotContext: { scope: ["devices"] }, // least-trusted peer: scope it
});
adapter.start({ registry, consumer: { id: "browser-agent", kind: "webmcp" } });
```

If `navigator.modelContext` is absent, `start()` resolves and does nothing (feature-detect, never polyfill). Capability errors ride in tool content with `code`/`retry`/`details` preserved — never protocol-level errors.

Full specification: [docs/09](https://github.com/Wiseair-srl/agent-surface/blob/main/docs/09-adapters.md).

MIT © Wiseair S.r.l.
