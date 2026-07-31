# @agent-surface/testing

## 0.2.0

### Minor Changes

- 24a991b: Release all packages together at 0.2.0.

  `@agent-surface/orpc` and `@agent-surface/testing` now declare their `@agent-surface/react` peer as `>=0.1.0` rather than `workspace:^`. The caret range pinned the minor while React-side packages are still `0.x`, so every sibling minor read as a peer-range break — which is not what the constraint was ever meant to say. The packages are released in lockstep; the peer range now reflects that instead of forcing a major bump on packages whose own API did not change.

### Patch Changes

- Updated dependencies [df7663f]
- Updated dependencies [24a991b]
- Updated dependencies [e54f566]
  - @agent-surface/core@0.2.0
