# 11 — Non-Goals

> [!NOTE]
> **Status: Draft** (normative). Scope discipline is a feature. agent-surface provides the **data plane and primitives** for a typed, governable frontend agent surface — and stops there. Each non-goal below states what we refuse to build, why, and what to use instead. Revisiting any of these requires an explicit RFC, not scope creep.

## The first version will not become…

**1. A complete agent framework.**
No agent loop, no planner, no tool-choice logic, no conversation state. The library produces tool catalogs and executes tool calls. *Instead:* the host's agent loop (Vercel AI SDK, Anthropic SDK, LangGraph, anything) consumes the toolset ([09](09-adapters.md#embedded-toolset-adapter-draft)).

**2. A new RPC framework, or a replacement for oRPC.**
No transport, no serialization protocol, no server runtime. Domain operations stay oRPC procedures. *Instead:* `@agent-surface/orpc` references them ([05](05-orpc-integration.md)).

**3. A browser-automation or computer-use framework.**
No DOM scanning, no selectors, no synthetic mouse/keyboard, no screenshots, no coordinates. That model is the problem statement, not the roadmap. *Instead:* Playwright/computer-use tools exist for the pages that haven't adopted an explicit surface; a constrained fallback is at most Future, non-core ([09 §playwright](09-adapters.md#playwright--dom-fallback-future)).

**4. A chat library.**
No chat UI, no message rendering, no streaming UI. The confirmation host is the only UI-adjacent seam, and even that is host-rendered.

**5. A memory system.**
No persistence of agent state, embeddings, or history. Snapshots are ephemeral by design.

**6. A workflow engine.**
No multi-step orchestration, retry DAGs, or saga semantics. One invocation = one capability execution; composition lives in the agent loop or the backend.

**7. A generative-UI system.**
The library never renders or generates components; it annotates components the app already renders. (A generative-UI system could *target* agent-surface as its control plane — that's someone else's library.)

**8. An alternative protocol to MCP or WebMCP.**
No wire protocol is defined here. Snapshots/invocations are in-memory shapes that adapters translate; WebMCP is one possible transport, never the foundation ([09 §webmcp](09-adapters.md#webmcp-adapter-experimental)).

**9. An enterprise authorization framework.**
No roles, no policy language, no permission storage. Policies are middleware interfaces delegating to the host's auth; the server stays authoritative ([06](06-policies-and-security.md)). Approval workflows beyond single-user confirmation are the backend's business (orpc-agent).

**10. A tool that exposes the whole DOM automatically.**
This is the founding non-goal. There is deliberately no "expose everything" switch, no auto-annotation codemod in core, no implicit registration. If a future DX tool suggests annotations, it outputs *code for humans to review*, never runtime exposure.

## Boundary clarifications

- **In scope:** registry, identity, schemas, snapshot, invocation, policies, confirmation evidence, errors, audit events, React lifecycle bindings, oRPC references, testing harness, adapter contract.
- **Out of scope but adjacent (host's job):** the model/agent loop, auth systems, routers, data fetching, design systems, audit *persistence*, server approvals.
- **Deferred, not refused (see [12-roadmap.md](12-roadmap.md)):** cross-tab/multi-window surfaces, MCP bridge, relevance ranking, iframe/worker isolation for third-party registrants, deep binding paths, binary payloads.
