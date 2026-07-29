# 04 — React API (`@agent-surface/react`)

> [!NOTE]
> **Status: Draft** unless marked otherwise. Peer dependency: `react >= 18.2` (React 19 supported). Everything here is a thin, lifecycle-correct binding over the core registry — no behavior exists here that contradicts [03-core-api.md](03-core-api.md).

> [!TIP]
> One rule explains most of this page: **registration happens once per mount, in an effect; handlers are read through a ref at invocation time.** That is why there are no dependency arrays, no `useCallback` requirements, and no stale-closure bugs — and why Strict Mode, Suspense, and SSR all work without special cases.

## Provider

```tsx
export interface AgentSurfaceProviderProps {
  registry: AgentSurfaceRegistry;
  children: React.ReactNode;
}

export function AgentSurfaceProvider(props: AgentSurfaceProviderProps): JSX.Element;

/** Access the registry from context. Throws if no provider is mounted. */
export function useAgentSurface(): AgentSurfaceRegistry;
```

- The application creates the registry **once** (module scope or top-level `useState` initializer) and passes it down. The provider never creates a registry implicitly — registry creation is where environment, policies, audit, and route wiring live, and that must be explicit host code.
- Multiple providers/registries in one tree are allowed (isolation, storybooks, tests); hooks bind to the nearest provider.

Typical wiring:

```tsx
// agent-surface.ts (host app)
export const registry = createAgentSurfaceRegistry({
  environment: import.meta.env.DEV ? "development" : "production",
  context: () => ({ user: authStore.user, tenantId: authStore.tenantId }),
  policies: [authenticated()],
  route: () => ({ path: router.state.location.pathname }),
});
```

```tsx
<AgentSurfaceProvider registry={registry}>
  <App />
</AgentSurfaceProvider>
```

## `useAgentComponent` — the recommended default

One aggregated hook per agent component. This is the **recommended authoring style**: one registration, one atomic descriptor, one lifecycle, minimal version churn.

```tsx
export interface UseAgentComponentConfig extends Omit<AgentComponentDefinition, "procedures"> {
  /**
   * Gate for "mounted but not presented" (inactive tab, keep-alive, exit
   * animation). false ⇒ all capabilities visible-disabled. Default true.
   */
  enabled?: boolean;
}

export interface AgentComponentHandle {
  /** Current registrationId; changes on remount/re-register. */
  registrationId: string | undefined;
  status: "active" | "rejected" | "unregistered" | "pending";
}

export function useAgentComponent(config: UseAgentComponentConfig): AgentComponentHandle;
```

Example (canonical style, with the `action`/`observation` helpers from core):

```tsx
function DevicesTable() {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sorting, setSorting] = useState<Sorting>({ by: "name", dir: "asc" });
  const devices = useDevicesQuery();

  useAgentComponent({
    type: "devices.table",
    description: "Table of the devices visible on the current devices page",
    observations: {
      readState: observation({
        description: "Visible rows (id, name, status, city), selection, sorting",
        output: DeviceTableStateSchema,
        read: () => ({
          visibleRows: devices.data.map(toMinimalRow),
          selectedIds,
          sorting,
        }),
      }),
    },
    actions: {
      selectRows: action({
        description: "Replace, extend or reduce the row selection",
        input: SelectRowsSchema,
        effect: "local-state",
        precondition: ({ ids }) => {
          const unknown = ids.filter((id) => !devices.byId.has(id));
          if (unknown.length) return { message: "Unknown device ids", details: { unknown } };
        },
        execute: ({ ids, mode }) => setSelectedIds(applySelection(selectedIds, ids, mode)),
      }),
      sort: action({
        description: "Change table sorting",
        input: SortSchema,
        effect: "local-state",
        idempotent: true,
        execute: (s) => setSorting(s),
      }),
    },
  });

  return <Table … />;
}
```

### Registration mechanics (normative)

1. **Registration happens in an effect, never during render.** Render must stay pure (Strict Mode double-invokes it; concurrent rendering may throw renders away). The hook registers in a passive effect after commit and unregisters in the effect cleanup.
2. **Registration identity** is keyed by `(registry, plane, type, instanceId)`. While those are unchanged across re-renders, the registration persists — same `registrationId`, no version churn.
3. **Changing identity keys** (`type` or `instanceId` changed between renders) unregisters and re-registers (new `registrationId`). Legitimate (e.g. instanceId follows an entity id) but agents will see the old instance vanish; don't churn identity gratuitously.
4. **Structural config changes on a live registration** (different capability names, schemas, descriptions, effects, policies) are a spec violation of D2. The hook detects a changed structural fingerprint in development, logs an explanatory error, and re-registers (new `registrationId`) so the surface never lies about what `reg_x` can do. In production it re-registers silently. Keep structure static per mount; put dynamism in `when`/`enabled`/handlers.

### Handler freshness (D3) — why there is no dependency array

`useAgentComponent` takes no deps and never asks you to memoize. Every render, the hook writes the freshly-created config into a stable ref; the core registry reads `execute`/`read`/`when` through that ref **at invocation time**. Consequences:

- Handlers always see current props/state — the stale-closure class of bugs is designed out.
- Re-created closures cause zero re-registration and zero surface-version changes.
- You MUST NOT capture and freeze a config object in `useMemo` to "optimize" — that recreates the stale-closure problem the ref pattern removes.

### Availability is reactive

`when()` predicates and `enabled` are evaluated during render commit: the hook compares the evaluated availability vector against the last pushed one and calls `handle.update({availability, enabled})` on change. So in React apps, availability changes are **pushed** — the surface version bumps, `surface-changed` fires, adapters refresh. (This is the push half of the split defined in [03 §availability](03-core-api.md#availability).)

```tsx
actions: {
  clearSelection: action({
    …,
    when: () => selectedIds.length > 0,
    unavailableReason: "No rows are selected",
    execute: () => setSelectedIds([]),
  }),
}
```

### Visibility

Unmounting always removes capabilities. But "mounted and invisible" needs explicit handling:

| UI pattern | What to do |
|---|---|
| Inactive tab that stays mounted | `enabled: isActiveTab` |
| Virtualized off-screen rows | usually: don't register per-row components at all; register the list once |
| Exit animation / route crossfade | old page sets `enabled: false` on exit start, or registry `onDuplicateInstance: "replace"` |
| `<Activity>` / keep-alive hiding | React runs effect cleanup on hide ⇒ automatic unregister; nothing to do |

## Strict Mode, Suspense, SSR, concurrency

- **Strict Mode (development)**: mount → unmount → mount produces register → unregister → register: two short-lived registrationIds, two version bumps. This is correct and intentional — it proves cleanup symmetry. Tests and adapters MUST NOT assume registrationIds are stable across Strict Mode remounts; the testing package normalizes them ([08-testing.md](08-testing.md#semantic-snapshots)).
- **Suspense**: a suspended component never committed, so it never registered. On unsuspend, the effect runs and registration appears. If a boundary later hides committed content, React's cleanup semantics unregister it. Net rule: *the surface contains exactly what React has committed and is showing* — no special casing needed.
- **SSR / RSC**: hooks are client-only (`"use client"` modules). During server render nothing registers (effects don't run). No registry access during render means zero hydration mismatch by construction.
- **Concurrent rendering**: because registration is commit-phase only and identity is data-derived, interrupted/discarded renders have no effect on the surface.
- **HMR (dev)**: module replacement remounts components; effect cleanup handles it. Keep the *registry itself* stable across HMR with the usual guard, or every reload resets the surface:

```ts
export const registry: AgentSurfaceRegistry =
  (globalThis.__agentSurface ??= createAgentSurfaceRegistry({ … }));
```

## Instances: lists, duplicates, portals, recursion

- **Two tables of the same type on one page** → distinct `instanceId`s (`"main"`, `"comparison"`). Omitting them makes the second registration collide (dead handle + dev error).
- **Dynamic lists** (a component per entity) → `instanceId: entity.id`. NEVER an array index: indices are render-order identity, which the spec forbids.
- **Recursive components** (tree nodes) → `instanceId: node.id`, `parent: { type, instanceId: node.parentId }`. Depth is irrelevant; identity comes from data.
- **Portals** → irrelevant. Identity is explicit; where the DOM lands does not matter.
- **Multiple browser tabs / windows** → one registry per tab; surfaces are independent. Cross-window aggregation is Future ([12-roadmap.md](12-roadmap.md)).
- **Route transitions** → unmount unregisters; in-flight invocations settle `COMPONENT_UNMOUNTED` — **except `navigation`-effect actions**, which settle on handler settlement so a successful transition that unmounts its own component still reports `ok` (D23, [03 §concurrency](03-core-api.md#concurrency-timeouts-cancellation)). Author navigation handlers to resolve when the router accepts the transition — `await router.navigate(...)` where available, or plain `router.push(); return;` for synchronous routers. A `navigation` action's result carries `surfaceChanged: true` when the version moved during execution, cueing the agent to re-discover before its next step.

## Granular hooks — Experimental

For capabilities contributed from separate files/subcomponents. The aggregated hook remains the default recommendation: one registration is atomic (agents never observe a half-built component), its descriptor is reviewable in one place, and it produces one version bump instead of N. Granular composition trades that for flexibility; it is Experimental until real usage justifies its lifecycle complexity (late-added capabilities are structural changes ⇒ each attach/detach re-registers the *capability set* of the scope).

```tsx
/** Establishes a component scope; children attach capabilities to it. */
export function AgentComponentScope(props: {
  config: Omit<UseAgentComponentConfig, "observations" | "actions">;
  children: React.ReactNode;
}): JSX.Element;

export function useAgentAction<TIn extends JsonValue, TOut extends JsonValue | void = void>(
  name: string,
  def: AgentActionDefinition<TIn, TOut>,
): void;

export function useAgentObservation<TOut extends JsonValue>(
  name: string,
  def: AgentObservationDefinition<TOut>,
): void;
```

Attach/detach batching: capability attachments within one commit are coalesced into a single (re-)registration. A child mounting later than its scope still causes a re-register of the scope (new registrationId) — this is the inherent cost of late structural change and the main reason the aggregated hook is preferred.

## Confirmation UI

```tsx
export interface PendingConfirmationView extends PendingConfirmation {
  approve(): void;
  deny(reason?: string): void;
}

/** Reactive list of pending confirmations for host-rendered dialogs. */
export function usePendingConfirmations(): PendingConfirmationView[];
```

```tsx
function AgentConfirmationHost() {
  const pending = usePendingConfirmations();
  const current = pending[0];
  if (!current) return null;
  return (
    <ConfirmDialog
      title="The assistant wants to perform an action"
      summary={current.summary}
      payload={current.input}
      expiresAt={current.expiresAt}
      onConfirm={() => current.approve()}
      onCancel={() => current.deny("user-declined")}
    />
  );
}
```

The dialog is *representation*, not policy: approving calls `registry.confirmations.resolve`, which mints the single-use evidence; everything enforceable lives in core ([06-policies-and-security.md](06-policies-and-security.md#confirmation)).

## Anti-patterns (normative SHOULD NOTs)

- Deriving `type`/`instanceId` from labels, i18n strings, DOM ids, or render order.
- Registering one component per DOM widget out of habit — granularity follows *user intent*; a filter bar with five inputs is usually **one** `devices.filters` component with one `set` action.
- Exposing raw internal state in observations (`read: () => wholeReduxStore`). Return the minimal semantic projection an agent needs.
- Making a `view:` action call your API client directly. That is a domain operation: define an oRPC procedure and reference it ([05-orpc-integration.md](05-orpc-integration.md)). The plane rule (`PLANE_VIOLATION`) catches declared effects, but it cannot see inside your handler — this one is on the author and the code reviewer.
- Gating destructive behavior only in the UI dialog instead of `confirmation: "required"` — dialogs are bypassable representation; the policy is what the runtime enforces.
