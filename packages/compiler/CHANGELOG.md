# @agent-surface/compiler

## 0.19.1

### Patch Changes

- 3c07ad1: Compile the capability contract under the dev server and the test runner, not only in a production build.

  `agentSurface()` was `apply: "build"`, and the manifest it inlines into
  `virtual:agent-surface-contract` was substituted in `renderChunk` — a hook
  Rollup only runs when bundling. Outside a build the module therefore did not
  resolve at all, and forcing the plugin on produced
  `ReferenceError: __AGENT_SURFACE_MANIFEST_… is not defined`. Since 0.17 made
  compiler authority mandatory, that left a consumer with no way to run
  `vite dev`, and no way to unit-test a component that registers: every
  registration failed with `raw registration rejected: bind a compiler-generated
contract`. The repository's own suite did not catch it because it runs with
  `enableUnsafeAuthorityTestMode()`, which is deliberately not exported —
  `examples/devices-app` passes through a seam no consumer has.

  The plugin now compiles the contract eagerly in `buildStart` when
  `command === "serve"`, through the same `compileCapabilityContract` the CLI
  uses, and inlines the real manifest and the real hash. A dev or test run gets
  the same authority a build does, over the whole production graph rather than
  whatever modules the server happened to request. Editing a contract recompiles
  it and reloads the page, because every already-loaded proof is pinned to the
  previous manifest hash.

  Two consequences worth knowing:

  - The eager compile inherits the serving config's `resolve.alias` and its
    `configFile`, so a project that configures Vite inline — which is what a
    vitest setup usually does — compiles against the modules it serves.
  - Vite's optimized-dependency chunks (`node_modules/.vite/`) are no longer
    scanned. They are bundled output containing several dependencies at once,
    this package among them, so the raw-registration guards matched
    `registry.register({` inside a vendor chunk and refused to serve the app.

- Updated dependencies [3c07ad1]
  - @agent-surface/core@0.19.1

## 0.19.0

### Minor Changes

- e3f7037: Restores lockstep versioning: all seven packages ship on 0.19.0.

  0.18.0 released `@agent-surface/core`, `@agent-surface/compiler` and
  `@agent-surface/cli` alone, because the two changesets behind it
  (`olive-hoops-shave.md`, `tall-donkeys-attack.md`) each named only those
  three packages. The frontmatter of a release changeset is a lockstep
  declaration rather than a description of the diff
  ([.changeset/README.md](../.changeset/README.md)), so `react`, `orpc`,
  `testing` and `webmcp` were left behind at 0.17.1 — the same failure, and
  the same cause, as 0.6.0, 0.11.0 and 0.14.0.

  `react`, `orpc`, `testing` and `webmcp` were carried to 0.18.0 in the
  manifests and are published here at **0.19.0**; they have **no 0.18.0 on
  npm**. That gap is the repair, not a silent release: nothing shipped in it.

  No functional change in any of the four.

### Patch Changes

- Updated dependencies [e3f7037]
  - @agent-surface/core@0.19.0

## 0.18.0

### Minor Changes

- 1ada887: Require consumer authorization for external capability contracts (contract format v5).

  A dependency could previously contribute capabilities to the manifest just by being in the production graph — through an `agentSurface.contract` sidecar, or by calling a contract macro in its own shipped source, which needed no sidecar and produced no digest at all. Discovery is no longer authorization: both routes now require an explicit approval keyed by package name.

  ```ts
  agentSurface({
    externalContracts: {
      allow: [{ package: "@vendor/plugin", digest: "6f4b…" }],
    },
  });
  ```

  The manifest records contract integrity (`contractDigest`) and consumer consent (`authorization.expectedDigest`) as separate fields, so an unapproved contributor and an approved contributor that changed are distinguishable failures. Both fail the build with the digest to review; neither has an escape flag.

  **Breaking.** `formatVersion` is now `5` — run `agent-surface snapshot` to regenerate committed contracts. The plugin's `externalContracts` option takes `{ allow: [...] }` instead of an array of `{ path, digest }`; `PinnedContractInput` is replaced by `ExternalContractAllowEntry` and `ExternalContractPolicy`, and `ExternalCapabilityContractDigest` by `ExternalContractAttribution`. The CLI approves a dependency with `--allow <package>=<sha256>`.

### Patch Changes

- 1ada887: Forward external-contract options from `compileCapabilityContract` to the compiler plugin.

  The option existed on the Vite plugin but `compileCapabilityContract` dropped it, so `agent-surface check` and `snapshot` — which both go through it — could not pin or approve an external contract at all. Auto-discovery from the module graph was the only route that worked in CI, which is exactly the route that needed a consumer decision.

- Updated dependencies [1ada887]
  - @agent-surface/core@0.18.0

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
