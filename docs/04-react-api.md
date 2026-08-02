# React API

`@agent-surface/react` connects compiled component contracts to mounted React state. Its public registration API is contract-first: static semantics come from the compiler-authorized contract; the hook accepts only live runtime bindings.

## Provider

Create one registry for the application and provide it above every registering component:

```tsx
import authority from "virtual:agent-surface-contract";
import { createAgentSurfaceRegistry } from "@agent-surface/core";
import { AgentSurfaceProvider } from "@agent-surface/react";

const registry = createAgentSurfaceRegistry({ authority });

root.render(
  <AgentSurfaceProvider registry={registry}>
    <App />
  </AgentSurfaceProvider>,
);
```

```ts
interface AgentSurfaceProviderProps {
  registry: AgentSurfaceRegistry;
  children: ReactNode;
}

function useAgentSurface(): AgentSurfaceRegistry;
```

`useAgentSurface()` throws when no provider is present.

## Component binding

```tsx
const handle = useAgentComponent(devicesTableContract, {
  instanceId: props.instance,
  observations: {
    readState: { read: () => ({ rows, selectedIds }) },
  },
  actions: {
    selectRows: {
      when: () => rows.length > 0,
      execute: ({ ids }) => setSelectedIds(ids),
    },
  },
});
```

The compiled contract owns:

- component and capability identity;
- descriptions and schemas;
- effects, reversibility, confirmation, tags, and policy attachments.

The runtime binding owns:

- handlers and current state;
- `instanceId`;
- `enabled` and per-capability `when` gates;
- preconditions and contextual metadata.

The return value reports the current registration:

```ts
interface AgentComponentHandle {
  registrationId: string | undefined;
  status: "active" | "rejected" | "unregistered" | "pending";
}
```

## Lifecycle

- registration happens in a React effect;
- cleanup unregisters the complete component surface;
- Strict Mode effect replay produces no leaked registration;
- changing `type` or `instanceId` creates a new registration;
- structural contract semantics stay fixed for one registration;
- changes to `enabled` or `when` are pushed to the registry after render;
- unmount aborts active non-navigation invocations and rejects stale references.

### Handler freshness

Handlers are read through an internal latest-value reference at invocation time. They see current props and state without a dependency array or `useCallback`. Updating a handler closure does not change capability identity or `surfaceVersion`.

Structural changes are different: identity, schemas, descriptions, effects, and policy shape cannot change under an existing `registrationId`. If a live binding changes structure, the hook reports the authoring error and registers a new immutable descriptor.

## Visibility

Use `enabled: false` when a component remains mounted but is not presented, such as an inactive tab or keep-alive route. Use per-capability `when` for state-specific availability. React pushes gate changes to the registry after each commit so adapters can refresh the surface.

Authority decisions and UI state remain distinct: policies may hide a capability; `enabled` and `when` expose it as unavailable with a reason.

## Anti-patterns

- Do not derive contract identity, descriptions, schemas, effects, or policy attachments from props or state.
- Do not use a `view:` action to duplicate a backend procedure; bind a compiled procedure contract instead.
- Do not keep an off-screen component enabled only because React keeps it mounted.
- Do not capture discovery results as execution authority; invocation re-checks live state and policy.
- Do not construct a registry inside component render. Create one at the application composition root.

## Domain procedure binding

Use `@agent-surface/orpc/react` to attach UI context to a compiled procedure contract:

```tsx
import { useAgentProcedure } from "@agent-surface/orpc/react";

useAgentProcedure(devicesDisableContract, bridge.refs.devices.disable, {
  bind: () => ({ deviceIds: selectedIds }),
  when: () => selectedIds.length > 0,
});
```

The contract provides the domain identity and governance metadata. The bridge reference provides authoritative execution. The runtime config provides live bindings and availability. See [oRPC integration](05-orpc-integration.md).

## Confirmation UI

```ts
const pending = usePendingConfirmations();
```

`usePendingConfirmations()` subscribes to registry confirmation events and returns the pending records the host must render. Resolve a record through `registry.confirmations.approve()` or `.deny()`; do not construct confirmation evidence in component state.
