# 11 — Non-Goals

> [!NOTE]
> **Status: Draft** (normative). Scope discipline is a feature. agent-surface provides the **data plane and primitives** for a typed, governable frontend agent surface — and stops there. Each non-goal below states what we refuse to build, why, and what to use instead. Revisiting any of these requires an explicit RFC, not scope creep.

## The first version will not become…

**1. A complete agent framework.**
No agent loop, no planner, no tool-choice logic, no conversation state. The library produces tool catalogs and executes tool calls. *Instead:* the host's agent loop (Vercel AI SDK, Anthropic SDK, LangGraph, anything) consumes the toolset ([Adapters](09-adapters.md#embedded-toolset-adapter-draft)).

**2. A new RPC framework, or a replacement for oRPC.**
No transport, no serialization protocol, no server runtime. Domain operations stay oRPC procedures. *Instead:* `@agent-surface/orpc` references them ([oRPC integration](05-orpc-integration.md)).

**3. A browser-automation or computer-use framework.**
No DOM scanning, no selectors, no synthetic mouse/keyboard, no screenshots, no coordinates. That model is the problem statement, not the roadmap. *Instead:* Playwright/computer-use tools exist for the pages that haven't adopted an explicit surface; a constrained fallback is at most Future, non-core ([Adapters §playwright](09-adapters.md#playwright--dom-fallback-future)).

**4. A chat library.**
No chat UI, no message rendering, no streaming UI. The confirmation host is the only UI-adjacent seam, and even that is host-rendered.

**5. A memory system.**
No persistence of agent state, embeddings, or history. Snapshots are ephemeral by design.

**6. A workflow engine.**
No multi-step orchestration, retry DAGs, or saga semantics. One invocation = one capability execution; composition lives in the agent loop or the backend.

**7. A generative-UI system.**
The library never renders or generates components; it annotates components the app already renders. (A generative-UI system could *target* agent-surface as its control plane — that's someone else's library.)

**8. An alternative protocol to MCP or WebMCP.**
No wire protocol is defined here. Snapshots/invocations are in-memory shapes that adapters translate; WebMCP is one possible transport, never the foundation ([Adapters §webmcp](09-adapters.md#webmcp-adapter-experimental)).

**9. An enterprise authorization framework.**
No roles, no policy language, no permission storage. Policies are middleware interfaces delegating to the host's auth; the server stays authoritative ([Policies & Security](06-policies-and-security.md)). Approval workflows beyond single-user confirmation are the backend's business (orpc-agent).

**10. A tool that exposes the whole DOM automatically.**
This is the founding non-goal. There is deliberately no "expose everything" switch, no auto-annotation codemod in core, no implicit registration. If a future DX tool suggests annotations, it outputs *code for humans to review*, never runtime exposure.

## Boundary clarifications

- **In scope:** registry, identity, schemas, snapshot, invocation, policies, confirmation evidence, errors, audit events, React lifecycle bindings, oRPC references, testing harness, adapter contract.
- **Out of scope but adjacent (host's job):** the model/agent loop, auth systems, routers, data fetching, design systems, audit *persistence*, server approvals.
- **Deferred, not refused (see [Roadmap](project/12-roadmap.md)):** cross-tab/multi-window surfaces, MCP bridge, relevance ranking, iframe/worker isolation for third-party registrants, deep binding paths, binary payloads.

## Known limitations (honest, normative — directive §9.4)

Things the current design *cannot* do, stated so nobody discovers them in production:

1. **No same-realm isolation.** Malicious JavaScript in the page can call the registry like any other code. Trust labels and guards segment *honest* registrants; containment requires an out-of-realm boundary that does not exist in 0.x ([Policies & Security §trust](06-policies-and-security.md#trust-model-for-registrants)).
2. **Bounded idempotency window.** Dedupe is LRU + TTL (`dedupeCacheSize`/`dedupeCacheTtlMs`), not a forever guarantee: a retry after eviction re-executes (D22). Handlers with hard exactly-once needs enforce it server-side.
3. **Cooperative cancellation only.** JS cannot force-kill a handler; timeout/cancel/unmount abort `ctx.signal` and classify the result, but a non-cooperative handler keeps running (its late settlement is only logged).
4. **No contextual gating for autonomous server-side agents in 0.x.** Frontend `when`/bindings gate agents that reach the surface through a live page (embedded, per-turn frontend tools). An agent with no page open sees whatever the server exposes — syncing frontend context to it is OQ-5, unbuilt.
5. **No automatic relevance ranking.** Snapshot size is governed by manual `scope`/`priority`/budgets; nothing guarantees the model sees "what matters now" (OQ-4).
6. **No cross-tab semantics.** One registry per JS realm; two tabs are two unrelated surfaces (OQ-3).
7. **Schema subset limits (D19).** Only the allowlisted JSON Schema keywords cross the boundary; some Zod/Valibot features won't convert and fail at registration by design.
8. **Third-party drift.** Provider tool APIs, WebMCP, and orpc-agent evolve independently; adapters absorb drift but can lag. The registry contract is the stable part, adapters are the weather.
