# @agent-surface/webmcp

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
