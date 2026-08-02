---
"@agent-surface/core": patch
"@agent-surface/compiler": patch
"@agent-surface/react": patch
"@agent-surface/orpc": patch
"@agent-surface/testing": patch
"@agent-surface/cli": patch
"@agent-surface/webmcp": patch
---

Compile the capability contract under the dev server and the test runner, not only in a production build.

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
