# agent-surface

> **Status: 0.3.0 on npm.** The specification in [docs/](docs/) was written first (documentation-driven development); the packages under [packages/](packages/) implement it — core registry, React bindings, oRPC procedure references, testing toolkit, and the experimental WebMCP adapter — with the [docs/08 test recipes](docs/08-testing.md) as the executable contract. Usable and explicitly not yet *Stable*: see the [graduation criteria](docs/12-roadmap.md). The name `agent-surface` is provisional.

**Working with this repo:**

```bash
pnpm install
pnpm build      # tsup builds for all packages
pnpm test       # vitest, no LLM anywhere
pnpm typecheck
```

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
| [`@agent-surface/core`](packages/core) | Framework-agnostic registry, types, policies, errors, snapshot, invocation, toolset | Implemented |
| [`@agent-surface/react`](packages/react) | Hooks binding component lifecycle to registrations | Implemented |
| [`@agent-surface/orpc`](packages/orpc) | Contextual references to oRPC procedures exposed via `orpc-agent` | Implemented |
| [`@agent-surface/testing`](packages/testing) | Render/discover/invoke/assert utilities, no LLM required | Implemented |
| [`@agent-surface/webmcp`](packages/webmcp) | WebMCP transport adapter | Implemented (Experimental) |

The [devices-app example](examples/devices-app) is the spec's acceptance artifact: the full [docs/10](docs/10-examples.md) page driven end to end by a scripted agent (no LLM), with the semantic surface snapshot committed as a reviewable artifact. Releases go through [Changesets](.changeset/README.md) (`pnpm changeset` → release PR → npm publish from CI).

There is deliberately **no per-framework agent package**: any stack that accepts JSON-Schema tools — Vercel AI SDK, Mastra, LangGraph, assistant-ui — consumes the provider-neutral toolset directly. The runnable example is `examples/devices-app` ([docs/10](docs/10-examples.md)); the server-side topology (Mastra loop + orpc-agent governance) is sketched as a wiring guide in [docs/16-mastra-assistant-ui.md](docs/16-mastra-assistant-ui.md) — hand-written snippets, not a package.

**Documentation: https://agent-surface-docs.vercel.app**

Installation:

```bash
pnpm add @agent-surface/core @agent-surface/react
```

Published as 0.x: usable, and explicitly not yet *Stable* — see the [graduation criteria](docs/12-roadmap.md).

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
| [16-mastra-assistant-ui.md](docs/16-mastra-assistant-ui.md) | Integration notes: wiring a Mastra loop + assistant-ui chat + orpc-agent governance (guide, not executable) |
| [17-maintainer-directive.md](docs/17-maintainer-directive.md) | Standing execution directive: what "10/10" requires, phase gates, PR procedure |
| [18-spec-corrections-rfc.md](docs/18-spec-corrections-rfc.md) | Accepted RFC closing the P0 protocol bugs (decisions D21–D26) |
| [19-catalog-scale-rfc.md](docs/19-catalog-scale-rfc.md) | Accepted RFC on catalog scale: prompt-prefix caching, meta-mode graduation, wire-name budget (decisions D28–D30) |

## Roadmap (short form)

- **v0.1** — shipped: all five packages, the example app, and the conformance manifest.
- **v0.2** — shipped, trust not surface area: meta-tools parity with direct mode, D25 concurrency groups, and a real support matrix (Node 20.19/22 × React 18.2/19, ESM + bundler smoke, Zod *and* Valibot).
- **v0.3** — shipped, catalog scale (D28–D30, the first host-driven correction cycle): capability state as structured data so a provider's prompt prefix survives a click, `mode:"meta"` graduated to supported, wire names held inside the provider's 64-char budget. The manifest is now 90/90 implemented.
- **v0.4** — adoption and enforcement: API compatibility reports, benchmark thresholds in CI, the `orpc-agent` manifest decision, and a second adoption context.
- **Later** — MCP bridge, multi-window surfaces, Playwright fallback as a separate non-core package.

See [docs/12-roadmap.md](docs/12-roadmap.md).

## Contributing

Security analysis, review of the as-built code against the documented invariants, and adoption feedback from a real application are the most useful contributions right now. Start with [CONTRIBUTING.md](CONTRIBUTING.md), report vulnerabilities via [SECURITY.md](SECURITY.md) (never a public issue), and follow the [Code of Conduct](CODE_OF_CONDUCT.md). The standing execution contract for maintainers is [docs/17-maintainer-directive.md](docs/17-maintainer-directive.md).

## License

MIT.
