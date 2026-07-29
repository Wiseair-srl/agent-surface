# agent-surface

> **Status: design phase.** This repository currently contains the specification of the library, written before the implementation (documentation-driven development). Nothing described here is published or implemented yet unless explicitly stated. The name `agent-surface` is provisional.

**agent-surface** is a TypeScript library for building frontend interfaces that AI agents can observe and control — *selectively, semantically, and under explicit governance*.

## The problem

Agents that operate web applications today mostly do it the wrong way around: they scan the DOM, guess at CSS selectors, click coordinates, or interpret screenshots. That approach is fragile (markup changes break it), unsafe (everything interactive is implicitly exposed), and semantically poor (the agent sees `<button class="btn-4">`, not "disable the selected devices").

On the backend, this problem has a clean answer. With [oRPC](https://orpc.unnoq.com) and `orpc-agent.dev`, a procedure is invisible to agents unless explicitly exposed; when exposed, it becomes a typed tool with contracts, auth, policies, approvals, and audit attached. The procedure remains the authoritative domain operation.

The frontend has no equivalent. agent-surface is that equivalent.

## The thesis

**If a component or capability is not explicitly annotated, it does not exist for the agent.**

agent-surface lets frontend components register *semantic capabilities* — not DOM nodes — into a runtime registry:

- **Observations** — read the semantic state of a view (`view:devices.table.readState`).
- **Actions** — change presentation state (`view:devices.table.selectRows`, `view:devices.drawer.open`).
- **Procedure references** — make an *existing* oRPC domain procedure contextually available, with inputs bound from UI state (`domain:devices.disable` with `deviceIds` bound to the current selection), without ever redefining it.

Capabilities are lifecycle-aware (they exist only while the component is mounted), typed (JSON Schema in/out), governed (composable policies, confirmation, audit), and versioned (stale invocations are rejected). The agent surface at any moment is a function of application state:

```text
agent surface = mounted components + current route + current state + policies
```

The library deliberately does **not** model `click`, `type`, or `focus`. It models what the user means: select rows, set a filter, open a drawer, focus a device on the map.

## Minimal example

```tsx
import { action, observation } from "@agent-surface/core";
import { useAgentComponent } from "@agent-surface/react";

function DevicesTable() {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const devices = useDevices(); // normal app data fetching

  useAgentComponent({
    type: "devices.table",
    description: "Table of the devices visible on the current page",
    observations: {
      readState: observation({
        description: "Visible rows, selection and sorting",
        output: DeviceTableStateSchema,
        read: () => ({
          visibleRows: devices.map(minimalRow),
          selectedIds,
        }),
      }),
    },
    actions: {
      selectRows: action({
        description: "Replace the current row selection",
        input: SelectRowsSchema,
        effect: "local-state",
        execute: ({ ids }) => setSelectedIds(ids),
      }),
    },
  });

  return <Table /* normal rendering */ />;
}
```

While this component is mounted, an agent connected through an adapter sees two capabilities — `view:devices.table.readState` and `view:devices.table.selectRows` — with typed schemas. When it unmounts, they are gone, and late invocations fail with a typed `COMPONENT_UNMOUNTED` error. Nothing else on the page is visible to the agent.

## Relationship with oRPC / orpc-agent

agent-surface splits the world into two planes and refuses to blur them:

| | Domain plane | Presentation plane |
|---|---|---|
| Meaning | Operations valid even with no UI open | Capabilities of the currently mounted view |
| Examples | disable device, generate report, invite user | set filter, select rows, open drawer, navigate |
| Owner | Backend, via oRPC + `orpc-agent` | Frontend, via agent-surface |
| ID prefix | `domain:` | `view:` |
| Authority | Server re-validates everything | Client runtime, advisory only |

agent-surface never duplicates a domain procedure as a frontend tool. It can only *reference* one — making it contextually visible, binding inputs from UI state, adding frontend confirmation UX — while the backend remains the sole authority. See [docs/05-orpc-integration.md](docs/05-orpc-integration.md).

## Planned packages

| Package | Purpose | Status |
|---|---|---|
| `@agent-surface/core` | Framework-agnostic registry, types, policies, errors, snapshot, invocation | Draft spec |
| `@agent-surface/react` | Hooks binding component lifecycle to registrations | Draft spec |
| `@agent-surface/orpc` | Contextual references to oRPC procedures exposed via `orpc-agent` | Draft spec |
| `@agent-surface/testing` | Render/discover/invoke/assert utilities, no LLM required | Draft spec |
| `@agent-surface/webmcp` | WebMCP transport adapter | Experimental spec |

There is deliberately **no per-framework agent package**: any stack that accepts JSON-Schema tools — Vercel AI SDK, Mastra, LangGraph, assistant-ui — consumes the provider-neutral toolset directly. A full worked example (Mastra loop + assistant-ui chat + orpc-agent governance) is in [docs/16-mastra-assistant-ui.md](docs/16-mastra-assistant-ui.md).

Future installation (not yet published):

```bash
pnpm add @agent-surface/core @agent-surface/react
```

## Documentation

| Doc | Content |
|---|---|
| [00-vision.md](docs/00-vision.md) | Why this exists, design principles |
| [01-concepts.md](docs/01-concepts.md) | Planes, capabilities, identity, effects, availability — the conceptual model |
| [02-architecture.md](docs/02-architecture.md) | Packages, boundaries, data flow, runtime guarantees |
| [03-core-api.md](docs/03-core-api.md) | `@agent-surface/core` normative API |
| [04-react-api.md](docs/04-react-api.md) | `@agent-surface/react` normative API |
| [05-orpc-integration.md](docs/05-orpc-integration.md) | Domain procedure references and binding |
| [06-policies-and-security.md](docs/06-policies-and-security.md) | Policy pipeline, confirmation, threat model |
| [07-errors.md](docs/07-errors.md) | Typed error model |
| [08-testing.md](docs/08-testing.md) | `@agent-surface/testing` and test recipes |
| [09-adapters.md](docs/09-adapters.md) | Adapter contract, embedded toolset, WebMCP, MCP bridge |
| [10-examples.md](docs/10-examples.md) | End-to-end devices page walkthrough |
| [11-non-goals.md](docs/11-non-goals.md) | What this library refuses to be |
| [12-roadmap.md](docs/12-roadmap.md) | Versions and graduation criteria |
| [13-open-questions.md](docs/13-open-questions.md) | Decision log + genuinely open questions |
| [14-implementation-plan.md](docs/14-implementation-plan.md) | Milestones for implementing this spec |
| [15-completeness-review.md](docs/15-completeness-review.md) | Self-review of this specification |
| [16-mastra-assistant-ui.md](docs/16-mastra-assistant-ui.md) | Full-stack worked example: Mastra loop, assistant-ui chat, orpc-agent domain governance |

## Roadmap (short form)

- **v0.1** — core registry, React hooks, testing package, embedded toolset adapter.
- **v0.2** — oRPC procedure references, confirmation UX helpers, example app.
- **v0.3** — WebMCP adapter (experimental), surface budgeting.
- **Later** — MCP bridge, multi-window surfaces, Playwright fallback as a separate non-core package.

See [docs/12-roadmap.md](docs/12-roadmap.md).

## License

MIT (proposed).
