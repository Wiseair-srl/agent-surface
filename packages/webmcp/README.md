# @agent-surface/webmcp

> **Experimental.** The WebMCP (`navigator.modelContext`) surface area, permission model, and lifecycle are unstable; this adapter tracks them and absorbs the drift so nothing WebMCP-shaped leaks into `@agent-surface/core`. The application model stays in agent-surface — WebMCP is strictly transport/discovery.

WebMCP transport adapter for [agent-surface](https://github.com/Wiseair-srl/agent-surface): one wire-named tool per **available** capability, reconciled on every `surface-changed` (incremental `registerTool`/`unregisterTool` when the browser has them, a full `provideContext` otherwise). Unavailable capabilities are not registered (WebMCP has no disabled state today, so the availability reason is lost on this transport; accepted limitation). Observations and read-only effects carry `annotations.readOnlyHint`. The user agent is treated as the least-trusted consumer: scope the adapter and keep confirmations governed by the registry.

Docs: https://agent-surface.dev

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

If `navigator.modelContext` is absent, `start()` resolves and does nothing (feature-detect, never polyfill). Capability errors ride in tool content with `code`/`retry`/`details` preserved, never as protocol-level errors. `stop()` withdraws every tool the adapter exposed and can run repeatedly.

Confirmations are two-phase by default. To confirm in page within one tool call, pass host UI; it runs through WebMCP's `client.requestUserInteraction` and the registry still decides:

```ts
createWebMcpAdapter({
  confirm: (request) => showConfirmDialog(request.summary),
});
```

Only the imperative API is used. The declarative API (DOM forms as tools) is a non-goal: capabilities must be compiler-authorized, not derived from rendered DOM.

## Targeted WebMCP revision

The W3C Web Machine Learning CG draft ([webmachinelearning/webmcp](https://github.com/webmachinelearning/webmcp)) as exposed by the Chrome early preview (Chrome 146+, `chrome://flags/#enable-webmcp-testing`). Assumed surface:

| Member | Use |
|---|---|
| `modelContext.provideContext({ tools })` | required; fallback full-set replacement |
| `modelContext.clearContext()` | optional; `stop()` on the fallback path |
| `modelContext.registerTool(tool)` / `unregisterTool(name)` | optional, feature-detected together |
| tool `{ name, description, inputSchema, annotations?: { readOnlyHint? }, execute(input, client) }` | tool shape |
| `client.requestUserInteraction(callback)` | optional; in-page confirmation |

Keep this table in sync with [docs/09](https://github.com/Wiseair-srl/agent-surface/blob/main/docs/09-adapters.md#targeted-webmcp-revision).

Full specification: [docs/09](https://github.com/Wiseair-srl/agent-surface/blob/main/docs/09-adapters.md).

MIT © Wiseair S.r.l.
