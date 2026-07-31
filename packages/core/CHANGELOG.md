# @agent-surface/core

## 0.2.0

### Minor Changes

- df7663f: Implement configurable concurrency groups (D25, `AS-CONC-001` — the last requirement still marked `specified`).

  ```ts
  action({ /* … */ concurrency: { mode: "capability" } });
  ```

  - `AgentConcurrency = {mode:"instance"} | {mode:"capability"} | {mode:"key";key} | {mode:"parallel";max}`, each with an optional per-group `queueDepth`.
  - Default is unchanged: `{mode:"instance"}`, one FIFO queue per registration.
  - `parallel` requires an integer `max ≥ 1`; invalid groups throw `AgentSurfaceDefinitionError` at registration rather than degrading at runtime.
  - Groups are created on demand and dropped when idle, so the runtime holds one entry per currently contended group.
  - **Behavior change:** procedure references are now admitted through one group per procedure identity per referencing registration. Repeat calls of the same domain operation serialize client-side where they previously ran unbounded-parallel; a view action on the same component is never blocked by an in-flight domain call. Opt out with an explicit `concurrency` on the binding.

- 24a991b: Release all packages together at 0.2.0.

  `@agent-surface/orpc` and `@agent-surface/testing` now declare their `@agent-surface/react` peer as `>=0.1.0` rather than `workspace:^`. The caret range pinned the minor while React-side packages are still `0.x`, so every sibling minor read as a peer-range break — which is not what the constraint was ever meant to say. The packages are released in lockstep; the peer range now reflects that instead of forcing a major bump on packages whose own API did not change.

- e54f566: Meta-tools mode (Experimental) now honors the direct-mode contract.

  - `surface_read` no longer sends an empty `registrationId` when a target is not uniquely resolvable. An ambiguous read returned `STALE_CAPABILITY {retry:"after-refresh"}`, which sent agents into a refresh loop against an unchanged surface; it now returns `AMBIGUOUS_INSTANCE` with the instance list, matching `surface_act` and direct tools (`AS-ADAPTER-004`).
  - `surface_act` runs through the same invoke helper as direct tools, so staleness binding and the wait-mode confirmation retry no longer diverge.
  - **Behavior change:** the adapter-configured `scope` is now a floor (D27, `AS-ADAPTER-005`). A model-supplied `surface_discover({scope})` may only narrow it; `scope: []` is treated as "unspecified" rather than "everything", and a request outside the floor returns an empty surface. Previously the model's value replaced the configured one, so a scoped adapter could be widened back by asking. Callers relying on the old widening must raise the configured `scope` instead.
  - New `budget` option, `mode:"meta"` only — it truncates `surface_discover` and the `truncated` marker rides in the payload the model reads. Passing it with `mode:"direct"` now throws instead of silently dropping tools.
  - `toolset.subscribe` is documented as never firing in meta mode: the three-tool catalog is constant, and agents re-discover by comparing `surfaceVersion`.
