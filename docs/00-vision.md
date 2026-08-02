# Why agent-surface

> [!NOTE]
> This page explains the problem and design intent. [Concepts](01-concepts.md) defines the terminology.

## Why this library exists

AI agents are becoming legitimate operators of web applications: support copilots embedded in a dashboard, automation agents driving an admin panel, testing agents exercising flows. Today they operate frontends through mechanisms designed for humans or for scraping:

- generic DOM scanning and accessibility-tree dumps;
- CSS selectors that break on every refactor;
- screen coordinates and synthetic mouse/keyboard events;
- screenshot interpretation.

These approaches share three structural defects:

1. **Everything is implicitly exposed.** Any rendered interactive element is reachable. There is no opt-in, no policy, no audit. A prompt-injected agent can click anything a user can click.
2. **No semantics.** The agent sees structure, not intent. "Select the third row" is not "select device `dev_42`". Identity is positional and visual, so it is unstable and unverifiable.
3. **No lifecycle or authority model.** Nothing distinguishes "this action is valid right now, in this view, for this user" from "this button happens to exist in the DOM".

The backend world already solved the analogous problem. With oRPC and `orpc-agent.dev`, backend procedures are invisible to agents by default; exposing one is an explicit, typed, policy-governed act, and the procedure remains the single authoritative implementation of the domain operation.

**agent-surface applies the same philosophy to the frontend.** It gives an application the primitives to declare an explicit, semantic, typed, contextual, governable *agent surface* over its UI — and nothing more.

## The core principle

> If a component or capability is not explicitly annotated, it does not exist for the agent.

Everything else in this specification is a consequence of that sentence:

- **Explicit over implicit.** No automatic scanning, no auto-exposure of interactive elements, no "smart" discovery. Registration is code the application author writes and reviews.
- **Capabilities, not DOM.** The unit of exposure is a semantic capability (`view:devices.table.selectRows`), never a DOM node or a generic gesture (`click`, `type`). A React component may register zero, one, or many capabilities; the granularity follows user intent, not the component tree.
- **Two planes, never blurred.** Domain operations (meaningful with no UI open) belong to the backend via oRPC/`orpc-agent`. Presentation capabilities (meaningful only while a view is mounted) belong to agent-surface. The library structurally prevents redefining a domain operation as a frontend tool; it only allows *referencing* one.
- **Lifecycle-aware.** Capabilities exist exactly while their component is mounted and enabled. The surface is a projection of live application state, and stale invocations fail with typed errors.
- **Typed end to end.** Every observation output, action input/output, and procedure binding has a schema. TypeScript inference for authors, JSON Schema for agents.
- **Deny-by-default authority.** Descriptions never confer authority. Authority comes from registration, policies evaluated at invocation time, and — for domain operations — the server, which always re-validates. The frontend is not a security boundary; the library is designed so that nothing breaks when you assume it is hostile.
- **Runtime decides, not the model.** Whether an action may execute is decided by the registry's policy pipeline (and ultimately the server), never by the LLM's judgment or the tool description text.
- **Minimal transfer.** Snapshots are catalogs, not state dumps. The agent discovers capabilities lazily, reads state through targeted observations, and receives semantic, minimized data.
- **Progressive adoption.** One component can be annotated in an existing app without touching anything else. No framework rewrite, no router replacement, no provider lock-in.

## What agent-surface is

A small set of packages providing the **data plane and primitives** for a frontend agent surface:

- a framework-agnostic **registry** (registration, snapshot, invocation, subscription, policy evaluation, errors, audit events);
- **React bindings** that tie registrations to component lifecycle correctly (Strict Mode, Suspense, SSR, concurrent rendering);
- an **oRPC integration** that references existing domain procedures contextually, with UI-derived input bindings, without duplicating them;
- a **testing toolkit** that exercises the surface deterministically, without any LLM;
- **adapters** that connect the registry to embedded loops, WebMCP, and tests.

## What agent-surface is not

Not an agent framework, not a chat UI, not an RPC framework, not a browser-automation or computer-use tool, not a workflow engine, not an authorization product, and not a protocol competing with MCP/WebMCP. See [Limits and non-goals](11-non-goals.md). Core is protocol-neutral; WebMCP is one adapter.

## What success looks like

- An application team can expose its first capability in under an hour, and the diff is reviewable in one screen.
- A security reviewer can enumerate the complete production surface in the canonical compiler contract.
- An agent given the surface can complete "show me the offline devices in Milan, select the visible ones and disable them" by composing typed capabilities, with the destructive step gated by user confirmation and executed authoritatively by the backend.
- A test suite asserts all of the above with zero LLM calls.
- Adapters can implement different transports without changing the core model.

## Positioning

| Approach | Exposure model | Identity | Governance |
|---|---|---|---|
| Playwright / computer-use | Implicit: whole DOM/screen | Selectors, coordinates | None |
| Accessibility-tree agents | Implicit: whole a11y tree | Roles + text | None |
| Raw WebMCP tool registration | Explicit but ad-hoc, per-tool | Free-form strings | Per-tool, hand-rolled |
| **agent-surface** | **Explicit, component-scoped, lifecycle-bound** | **Stable canonical IDs, DOM-independent** | **Composable policies, confirmation, audit, staleness** |

DOM and Playwright fallbacks are outside the library. Adapters expose registered capabilities; they do not scan the page.
