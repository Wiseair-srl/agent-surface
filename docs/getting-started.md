# Getting started

> [!NOTE]
> Presentation plane only: one component, one observation, one action. No backend, no policies, no confirmations. Those come later — start [here](05-orpc-integration.md) for domain procedures, [here](06-policies-and-security.md) for governance.

Fifteen minutes, four steps: install, create a registry, annotate one component, then prove what you exposed.

## 1 · Install

```bash
pnpm add @agent-surface/core @agent-surface/react
pnpm add -D @agent-surface/testing @agent-surface/cli
```

Peer requirements: Node ≥ 20.19, React ≥ 18.2 (19 supported).

## 2 · Create the registry

One registry per application, created once. This is where environment, host context, policies and routing get wired, so it stays explicit host code — the provider never creates one for you.

```ts
// src/agent-surface.ts
import { createAgentSurfaceRegistry } from "@agent-surface/core";

export const registry = createAgentSurfaceRegistry({
  environment: import.meta.env.DEV ? "development" : "production",
});
```

```tsx
// src/main.tsx
import { AgentSurfaceProvider } from "@agent-surface/react";
import { registry } from "./agent-surface";

<AgentSurfaceProvider registry={registry}>
  <App />
</AgentSurfaceProvider>;
```

Nothing is exposed yet. An empty registry means an empty surface — there is no scanning path and no "expose everything" switch.

## 3 · Annotate one component

Pick a component with state an agent would want to read or change. Describe what it can do in terms of *user intent*, never DOM events: `selectRows`, not `click`.

```tsx
import { z } from "zod";
import { action, fromStandardSchema, observation } from "@agent-surface/core";
import { useAgentComponent } from "@agent-surface/react";

// Wrap any Standard Schema (Zod, Valibot, ArkType) with its JSON Schema.
const zs = <T extends z.ZodType>(s: T) =>
  fromStandardSchema(s, { jsonSchema: z.toJSONSchema(s) });

const FiltersState = z.object({
  status: z.enum(["all", "online", "offline"]),
  city: z.string().nullable().describe("Exact city name, null = all cities"),
});
const FiltersPatch = FiltersState.partial().describe("Omitted fields are unchanged");

export function DeviceFilters({ filters, onChange }: Props) {
  useAgentComponent({
    type: "devices.filters",
    description: "Status and city filters applied to the devices table",
    observations: {
      read: observation({
        description: "Currently active filters",
        output: zs(FiltersState),
        read: () => filters,
      }),
    },
    actions: {
      set: action({
        description: "Update one or both filters; omitted fields are unchanged",
        input: zs(FiltersPatch),
        effect: "local-state",
        idempotent: true,
        execute: (patch) => onChange({ ...filters, ...patch }),
      }),
    },
  });

  return <FilterBar /* your normal rendering, untouched */ />;
}
```

That is the whole integration. Three things worth knowing about it:

- **No dependency array, and none is needed.** The hook registers once per mount and reads `execute` / `read` / `when` through a ref at invocation time, so handlers always see current props and state. Freezing the config in a `useMemo` would reintroduce the stale-closure bug this design removes.
- **The schema is the source of truth.** `execute`'s argument type is inferred from `input`, and the runtime validates against it before your handler ever runs.
- **Mount is the lifetime.** On unmount the capabilities disappear, and a late invocation fails with a typed `COMPONENT_UNMOUNTED` instead of acting on a view that is gone.

While mounted, an agent now sees exactly two capabilities — `view:devices.filters.read` and `view:devices.filters.set` — and nothing else on the page.

## 4 · Prove it

Two ways, same normalizer. Neither needs an LLM.

**In a test**, which is where a surface change becomes a reviewable diff:

```tsx
import { renderAgentSurface } from "@agent-surface/testing/react";
import { matchers } from "@agent-surface/testing/matchers";
expect.extend(matchers);

it("exposes the filters", async () => {
  const s = await renderAgentSurface(<DevicesPage />);

  expect(s).toExpose("view:devices.filters.set");
  expect(s).toMatchSurfaceSnapshot();

  await s.invoke("view:devices.filters.set", { status: "offline" });
  expect(await s.observe("view:devices.filters.read")).toMatchObject({ status: "offline" });
});
```

**From a terminal**, once you add an [`agent-surface.config.tsx`](20-cli.md#configuration) pointing at the composition root you already have — `agent-surface init` scaffolds one:

```bash
agent-surface inspect
```

```text
2 authored (upper bound) · 2 call sites across 3 files · domain not analyzed, it comes from the oRPC router

scenario default
2 callable, 0 visible-disabled, 0 hidden

CAPABILITY            KIND         EFFECT       STATE     FLAGS
devices.filters.read  observation  —            callable  —
devices.filters.set   action       local-state  callable  idempotent · reversible

2 authored · 2 reached · 0 unreached · 1 scenario (default)
```

The last line is the one worth reading twice. It compares what your *code* authors against what your *scenarios* reach — so a route no scenario visits shows up as `unreached` rather than as nothing at all, and [`check`](20-cli.md#check) fails on it in CI.

## 5 · Hand it to an agent

`createAgentToolset` projects the surface as provider-neutral JSON-Schema tools. Vercel AI SDK, Mastra, LangGraph and assistant-ui all consume it directly, which is why there is no per-framework package.

```ts
import { createAgentToolset } from "@agent-surface/core";

const toolset = createAgentToolset(registry, {
  consumer: { id: "copilot", kind: "embedded" },
  topology: "embedded", // required: embedded → confirmations "wait", remote → "two-phase"
});

toolset.tools(); // [{ name, description, inputSchema, state, execute }]
```

Render `tool.state` outside the provider's tool block — availability changes whenever the user clicks, and tool definitions are the cached prompt prefix. [Adapters](09-adapters.md#rendering-capability-state) shows the split.

## Where to go next

| You want to… | Read |
|---|---|
| Understand planes, identity and availability | [Concepts](01-concepts.md) |
| Gate a capability on state (`when`, `enabled`) | [React API](04-react-api.md#availability-is-reactive) |
| Call a backend operation from the page | [oRPC integration](05-orpc-integration.md) — reference the procedure, never redefine it |
| Hide capabilities per user, or require confirmation | [Policies & Security](06-policies-and-security.md) |
| See all of it working together | [Devices page walkthrough](10-examples.md) |
| Gate the surface in CI | [Testing](08-testing.md) and [CLI](20-cli.md#check) |
