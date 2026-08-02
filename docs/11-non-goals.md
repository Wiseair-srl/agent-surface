# Limits and non-goals

agent-surface provides the data plane for a typed, governed frontend capability surface. The following responsibilities remain outside it.

## What the library does not provide

### Agent runtime

There is no model client, planner, tool-choice logic, or conversation state. The host's agent loop consumes an [adapter or toolset](09-adapters.md).

### RPC or server runtime

There is no network transport, server router, or backend authorization system. `@agent-surface/orpc` references existing procedures and forwards through the host's client.

### DOM automation

There is no DOM scanning, selector generation, synthetic input, screenshot interpretation, or coordinate control. Only explicitly declared capabilities enter the surface.

### Chat and application UI

There is no chat interface, message rendering, streaming UI, router, data fetching, or design system. The host also renders confirmation dialogs.

### Memory and orchestration

There is no persistence of agent state, embedding store, workflow graph, retry DAG, or saga engine. One invocation executes one capability. Composition belongs in the agent loop or backend.

### Generative UI

The library does not create components. It binds capabilities to components the application already renders.

### Authorization system

There is no role store, policy language, or approval workflow engine. Browser policies delegate to host context; servers remain authoritative.

### Wire protocol

Core snapshots and invocations are in-memory types. Adapters translate them to provider or browser protocols. WebMCP is one adapter, not the foundation of the architecture.

## Scope summary

| In agent-surface | Host or server responsibility |
|---|---|
| compiler manifest and authority | model and provider integration |
| registry, identity, snapshot, invocation | application handlers and UI |
| schemas, policies, confirmation evidence | authentication and permission data |
| errors, audit events, bounded concurrency | persistent audit and exactly-once effects |
| React lifecycle bindings | router and data layer |
| contextual oRPC references | backend procedure implementation |
| testing harness and adapters | cross-process transport |

## Current limitations

1. **No same-realm isolation.** Code running in the page can call application functions or provider SDKs directly. The authority guarantee covers public agent-surface execution APIs, not arbitrary host JavaScript.
2. **Bounded idempotency.** Dedupe uses LRU plus TTL. A retry after eviction is a new attempt; handlers requiring durable exactly-once semantics must enforce them server-side.
3. **Cooperative cancellation.** Timeout, cancellation, and unmount abort `ctx.signal`, but JavaScript cannot force-stop a non-cooperative handler. Late settlement is ignored and audited.
4. **Live-page context only.** `when`, bindings, and frontend confirmation govern agents that reach a live registry. Context synchronization to an autonomous server agent is not provided.
5. **Manual catalog relevance.** Hosts select direct or meta tools and may configure scope or budgets. The library does not rank capabilities by model relevance.
6. **One registry per JavaScript realm.** Tabs and windows are independent surfaces.
7. **JSON Schema subset.** Only the [supported keywords](03-core-api.md#supported-json-schema-subset) cross the boundary. Unsupported schema features fail during compilation or registration.
8. **External protocol drift.** WebMCP and provider APIs can change independently. Their adapters are Experimental where marked; the registry contract remains protocol-neutral.
