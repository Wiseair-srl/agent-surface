# @agent-surface/webmcp

## 0.5.0

### Minor Changes

- f688924: **Breaking.** The D28 compatibility flags are removed rather than flipped. There is now one way to compose a tool description, and it is the split one.

  ```diff
    const toolset = createAgentToolset(registry, {
      consumer,
      topology: "embedded",
  -   descriptionIncludesState: false,   // no longer an option — this is the behavior
    });

  - createAgentSurfaceRegistry({ snapshotMergesContextualNote: false });
  + createAgentSurfaceRegistry({});
  ```

  Removed: `AgentToolsetOptions.descriptionIncludesState`, `RegistryOptions.snapshotMergesContextualNote`, and `stableDescriptionOf` — the last existed only to recover a note-free description across the two modes, and `description` now _is_ that string.

  **What changes if you set neither flag** (i.e. you were on the defaults): `AgentTool.description` no longer contains `[currently unavailable: …]` or the binding's contextual note, and `AgentProcedureDescriptor.description` no longer has the note folded in. Both signals are still there as data — `AgentTool.state {available, unavailableReason?, note?}` and `AgentProcedureDescriptor.contextualNote` — and **you must render them somewhere the model reads**, or it will plan steps it cannot take. [09 §rendering-capability-state](https://github.com/Wiseair-srl/agent-surface/blob/main/docs/09-adapters.md#rendering-capability-state) has the trailing-block pattern.

  **Why removal instead of the planned flip.** [19 §C4](https://github.com/Wiseair-srl/agent-surface/blob/main/docs/19-catalog-scale-rfc.md) scheduled the flags for one minor: introduce, flip, remove. D28 landed in 0.3 rather than the 0.2 the RFC was written against, and 0.4 shipped without the flip, so they had already run three minors on 0.1 behavior. Pre-1.0, two code paths for one composition were carrying a migration nobody had asked for. Flipping first would have bought a second breaking change one minor later for the same hosts.

  Also: `core` drops to **18.12 kB** and its size budget is retightened 19 → 18.5 kB.

### Patch Changes

- Updated dependencies [f688924]
  - @agent-surface/core@0.5.0

## 0.4.1

### Patch Changes

- f897b7c: Documentation truth pass after 0.4.0. No behavior change in any package.

  0.4.0 shipped D31 alone, which left several published statements false:

  - **`descriptionIncludesState` and `snapshotMergesContextualNote` JSDoc** said the `true` default lasts "for one minor". It has now lasted three (0.2, 0.3, 0.4). This text ships in the `.d.ts`, so hosts read it in their editor — it now says "default through 0.4; flips in 0.5".
  - **[19 §C4](https://github.com/Wiseair-srl/agent-surface/blob/main/docs/19-catalog-scale-rfc.md)** scheduled the D28 flags as introduce-0.2 → flip-0.3 → remove-0.4. D28 landed in 0.3, and 0.4 shipped without the flip, so the live schedule is **flip in 0.5, remove in 0.6**. The accepted RFC answer is annotated rather than rewritten; the record of what was decided stays intact.
  - **[02 §budgets](https://github.com/Wiseair-srl/agent-surface/blob/main/docs/02-architecture.md#bundle-and-performance-budgets-first-measured-baselines)** claimed the 19 kB `core` budget returns at 0.5. Removal is 0.6, and flipping a default frees nothing regardless — both branches stay in the bundle while the flags exist.
  - **README and [12](https://github.com/Wiseair-srl/agent-surface/blob/main/docs/12-roadmap.md)** still described 0.4 as the unshipped "adoption and enforcement" milestone and pinned the packages at 0.3.0. v0.4 is recut as shipped; the enforcement work moves to v0.5.

  The D28 default flip is **not** in this release — it is a deliberate breaking change for any host that sets neither flag, and it needs a migration note rather than a patch bump.

- Updated dependencies [f897b7c]
  - @agent-surface/core@0.4.1

## 0.4.0

### Minor Changes

- 3588342: Release all packages together at 0.4.0.

  The discovery-honesty changes (D31) land in `core` only, but the packages ship in lockstep while we are pre-1.0 — see `.changeset/README.md`. The `AgentSurfaceSnapshot` shape is what every adapter reads, so a version that identifies the whole surface contract is more useful than four packages trailing a minor behind it.

### Patch Changes

- Updated dependencies [3588342]
- Updated dependencies [3588342]
  - @agent-surface/core@0.4.0

## 0.3.0

### Minor Changes

- 7d8644e: Release all packages together at 0.3.0.

  The catalog-scale corrections (D28–D30) land in `core` only, but the packages ship in lockstep while we are pre-1.0 — see `.changeset/README.md`. Adapters and hosts read the same `AgentTool` shape, so a version that identifies the whole surface contract is more useful than four packages trailing a patch behind it.

### Patch Changes

- Updated dependencies [7d8644e]
- Updated dependencies [7d8644e]
  - @agent-surface/core@0.3.0

## 0.2.0

### Minor Changes

- 24a991b: Release all packages together at 0.2.0.

  `@agent-surface/orpc` and `@agent-surface/testing` now declare their `@agent-surface/react` peer as `>=0.1.0` rather than `workspace:^`. The caret range pinned the minor while React-side packages are still `0.x`, so every sibling minor read as a peer-range break — which is not what the constraint was ever meant to say. The packages are released in lockstep; the peer range now reflects that instead of forcing a major bump on packages whose own API did not change.

### Patch Changes

- Updated dependencies [df7663f]
- Updated dependencies [24a991b]
- Updated dependencies [e54f566]
  - @agent-surface/core@0.2.0
