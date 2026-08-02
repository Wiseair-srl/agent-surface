# @agent-surface/compiler

## 0.17.0

### Minor Changes

- 1c4bf21: Make compiler authority mandatory across registration and exposure boundaries.

  - Verify and freeze format-v4 manifests at runtime.
  - Keep compiler proof private and compare runtime semantics to source truth.
  - Remove raw React/oRPC execution paths and unsafe adapter execute overrides.

### Patch Changes

- Updated dependencies [1c4bf21]
  - @agent-surface/core@0.17.0

## 0.16.0

### Minor Changes

- 45ffc48: Replace runtime surface discovery with compiler-generated capability contracts.

  Add the production-graph compiler, contract/binding APIs, strict manifest-backed runtime enforcement, provider exposure gateway, canonical artifact, and contract diff CLI. Remove scenarios, source extraction, depth limits, and allowlists.

### Patch Changes

- Updated dependencies [45ffc48]
  - @agent-surface/core@0.16.0
