# Testing (`@agent-surface/testing`)

> [!NOTE]
> No test requires an LLM. Contracts, discovery, invocation, confirmation, concurrency, and staleness are tested deterministically.

## Package shape

```text
@agent-surface/testing          core harness (framework-free, runs on the registry)
@agent-surface/testing/react    renderAgentSurface (peer: @testing-library/react)
@agent-surface/testing/matchers expect.extend matchers (vitest & jest compatible)
```

## Core harness

```ts
export interface TestSurfaceOptions {
  registry?: AgentSurfaceRegistry;         // authorized registry; takes precedence
  authority?: CapabilityAuthority;         // required when registry is omitted
  consumer?: AgentConsumer;                // default {id:"test", kind:"test"}
  host?: Record<string, unknown>;          // overrides RegistryOptions.context()
}

export interface TestSurface {
  registry: AgentSurfaceRegistry;
  snapshot(ctx?: Partial<SnapshotContext>): AgentSurfaceSnapshot;

  /** Invoke with test conveniences: auto invocationId, auto registrationId
      resolution from the latest snapshot, typed input. */
  invoke(capabilityId: string, input?: JsonValue, opts?: {
    instanceId?: string;
    registrationId?: string;               // pass a captured one to simulate staleness
    surfaceVersion?: string;
    confirmationId?: string;
    consumer?: AgentConsumer;
  }): Promise<AgentInvocationResult>;

  /** Sugar: invoke an observation and return its parsed output (throws on error). */
  observe<T = JsonValue>(capabilityId: string, opts?: { instanceId?: string }): Promise<T>;

  /** Capture current resolution tokens for later stale-invocation tests. */
  captureRef(capabilityId: string, instanceId?: string): {
    registrationId: string; surfaceVersion: string;
  };

  /** Swap host context mid-test (auth changes): as({user: admin}). */
  as(host: Record<string, unknown>): void;

  confirmations: {
    pending(): PendingConfirmation[];
    approve(confirmationId?: string): void;      // default: the only pending one
    deny(confirmationId?: string, reason?: string): void;
    expire(confirmationId?: string): void;       // advances the TTL clock for that record
  };

  /** All registry + audit events recorded since creation, in order. */
  events(): AgentSurfaceEvent[];
  auditLog(): AuditEvent[];

  dispose(): void;
}

export function createTestSurface(options?: TestSurfaceOptions): TestSurface;
```

The published harness has no raw-execution exception. Supply the application authority or a registry already created with it. The repository's own low-level tests use a non-exported Vitest setup seam solely to test registry mechanics in isolation.

Determinism requirements on the implementation: the harness MUST work under fake timers (vitest/jest) for TTL/timeout tests — core takes an injectable clock (`RegistryOptions` internal, exposed for tests as `limits`-adjacent option) rather than free-running `Date.now()` reads it can't virtualize.

## React harness

```tsx
export interface RenderAgentSurfaceOptions extends TestSurfaceOptions {
  wrapper?: React.ComponentType<{ children: React.ReactNode }>;  // routers, query clients…
}

export interface RenderedAgentSurface extends TestSurface {
  /** RTL render result (rerender/unmount/container…). */
  view: RenderResult;
  rerender(ui: React.ReactElement): void;
  unmount(): void;
}

export function renderAgentSurface(
  ui: React.ReactElement,
  options?: RenderAgentSurfaceOptions,
): Promise<RenderedAgentSurface>;   // resolves after mount effects flush
```

`renderAgentSurface` injects `AgentSurfaceProvider` automatically (with the harness registry) and flushes effects so registrations are live when it resolves. It runs fine under React Strict Mode — and the test suites of apps SHOULD keep Strict Mode on to prove cleanup symmetry.

## Matchers

```ts
expect(surface).toExpose("view:devices.table.selectRows");
expect(surface).toExpose("view:devices.table.selectRows", { instanceId: "main" });
expect(surface).not.toExpose("domain:devices.disable");        // hidden ≠ disabled
expect(surface).toExposeUnavailable("domain:devices.disable", {
  reason: "Select at least one device first",
});
expect(result).toBeOk();
expect(result).toFailWith("STALE_CAPABILITY", { reason: "registration-replaced" });
expect(surface).toMatchSurfaceSnapshot();                       // semantic snapshot, below
```

Matcher semantics are exact: `toExpose` means present **and available** for the harness consumer; `toExposeUnavailable` means present with `available: false` and an optional reason match. Absence assertions distinguish hidden from disabled because that distinction is part of the [security model](06-policies-and-security.md#hide-vs-disable).

## Semantic snapshots

`toMatchSurfaceSnapshot()` serializes the snapshot with volatility removed so it survives Strict Mode, remounts, and re-runs:

- `registrationId` → stable placeholders in first-appearance order (`<reg#1>`, `<reg#2>` …); `surfaceId`/`capturedAt` dropped; `surfaceVersion` dropped by default (opt-in via `{includeVersion: true}`);
- components and capabilities sorted canonically ([Core API §snapshot](03-core-api.md#snapshot) ordering);
- schemas included verbatim — schema drift is exactly what these snapshots are for catching.

The result is a reviewable, diffable statement of "what agents can see on this page" — useful as a PR artifact for security review.

## Recipes (normative test list)

These are the behaviors the spec obliges implementations and apps to be able to test; the example app's suite ([Examples](10-examples.md)) implements each at least once.

**Discovery**
```ts
const surface = await renderAgentSurface(<DevicesPage />, { authority });
expect(surface).toExpose("view:devices.filters.set");
expect(surface).toMatchSurfaceSnapshot();
```

**Invocation + observation round-trip**
```ts
await surface.invoke("view:devices.table.selectRows", { ids: ["d1"], mode: "replace" });
const state = await surface.observe<DeviceTableState>("view:devices.table.readState");
expect(state.selectedIds).toEqual(["d1"]);
```

**Unmount / lifecycle**
```ts
surface.unmount();
const r = await surface.invoke("view:devices.table.selectRows", { ids: ["d1"] });
expect(r).toFailWith("COMPONENT_UNMOUNTED");
```

**Staleness**
```ts
const ref = surface.captureRef("view:devices.table.selectRows");
surface.rerender(<DevicesPage key="remounted" />);          // new registration
const r = await surface.invoke("view:devices.table.selectRows",
  { ids: ["d1"] }, { registrationId: ref.registrationId });
expect(r).toFailWith("STALE_CAPABILITY", { reason: "registration-replaced" });
```

**Availability vs hiding (policy)**
```ts
surface.as({ user: viewerWithoutDevicesWrite });
expect(surface).not.toExpose("domain:devices.disable");     // authority → hidden
surface.as({ user: admin });
expect(surface).toExposeUnavailable("domain:devices.disable"); // state → disabled (no selection)
```

**Confirmation: approve / deny / expire / replay**
```ts
let r = await surface.invoke("domain:devices.disable", {}, { instanceId: undefined });
expect(r).toFailWith("CONFIRMATION_REQUIRED");
const { confirmationId } = (r as any).error.details;

surface.confirmations.approve(confirmationId);
r = await surface.invoke("domain:devices.disable", {}, { confirmationId });
expect(r).toBeOk();

r = await surface.invoke("domain:devices.disable", {}, { confirmationId });   // replay
expect(r).toFailWith("CONFIRMATION_INVALID", { reason: "consumed" });
```

**Input mismatch after approval (bait-and-switch)** — approve with selection A, change selection, retry: MUST fail `CONFIRMATION_INVALID {reason: "mismatch"}`.

**Locked binding override**
```ts
const r = await surface.invoke("domain:devices.disable", { deviceIds: ["victim"] });
expect(r).toFailWith("INVALID_INPUT", { lockedFields: ["deviceIds"] });
```

**Collisions** — render two same-`(type, instanceId)` components: second gets rejected, `surface.events()` contains `component-rejected`, and only one is exposed.

**Concurrency & dedupe** — fire two invokes with the same consumer + `invocationId` + request: handler executed once, both promises resolve with the identical result (`duplicate-call-joins-inflight`). Fire N>queue actions: overflow fails `RATE_LIMITED {reason: "queue-full"}`.

**Invocation-id conflict** — same consumer + same `invocationId` + *different* input or capability: `INVOCATION_CONFLICT {reason: "id-reused-with-different-request"}`, original record untouched (`invocation-id-conflict-fails-closed`). Two different consumers may reuse one provider tool-call id independently.

**Confirmation binds effective input** — with a live binding, the pending confirmation's `input` contains the bound values. A binding changed after discovery appears in the confirmation; a binding changed after approval returns `CONFIRMATION_INVALID {reason: "mismatch"}` instead of executing. Malformed bindings and supplied locked fields fail before a confirmation record is created.

**Navigation settlement** — a handler that commits the route and unmounts its owner in the same task settles `ok`; rejection before commit returns a typed failure; unmount before dispatch returns `COMPONENT_UNMOUNTED`; a timeout cannot overwrite a resolved result.

**Observation bounds** — saturate one consumer beyond its concurrency and queue limits; overflow returns `RATE_LIMITED {reason: "queue-full"}` while another consumer can still execute. Verify slot release on settlement, cancellation, and timeout.

**Timeout/cancellation** — fake timers; a hanging handler settles `TIMEOUT`, its `signal` is aborted, a late resolve is ignored and shows up as `late-settlement` in `auditLog()`.

**Observation purity (best-effort)** — the harness snapshots `surfaceVersion` before/after `observe`; a version change fails the test (an observation that mutates the surface is a defect). It cannot catch external side effects — that remains a review concern.

**oRPC binding** — with a mock executor (`registry.setProcedureExecutor(mock)`): assert the executor received merged, validated input with bound `deviceIds`; assert manifest-absent refs register nothing.

## CI posture

- All of the above runs in jsdom/node, no browser, no network, no model.
- Runtime harness snapshots verify behavior and policy projections. The repository inventory is `.agent-surface/contract.json`; `agent-surface check` validates source integrity and Git-base drift.
- Library CI additionally runs the core suite under both `environment: "test"` and `"development"` (to keep dev-only diagnostics from drifting), and the React suite under Strict Mode and React 18 + 19 matrices.
- `scripts/check-conformance.mjs` verifies that every implemented requirement in `spec/conformance.json` names an existing test containing that requirement id, and that `spec/error-matrix.json` matches the implemented error enum.
- Property-based invariants live in `packages/core/test/property/`: id and wire-codec round trips, canonical JSON, schema subset acceptance, live identity uniqueness, dedupe, and confirmation digest equality. Named race tests live in `packages/core/test/conformance/races.test.ts`.
- Performance baselines run via `pnpm bench` (`packages/core/bench/`); representative numbers are recorded under [Architecture §performance budgets](02-architecture.md#performance-budgets).
