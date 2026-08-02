---
"@agent-surface/cli": minor
"@agent-surface/compiler": minor
"@agent-surface/core": minor
"@agent-surface/orpc": minor
"@agent-surface/react": minor
"@agent-surface/testing": minor
"@agent-surface/webmcp": minor
---

Restore the version lockstep, and gate it in CI so it cannot break silently again.

The 0.21.0 release shipped `@agent-surface/cli` alone and left the other six packages at 0.20.1. That is not cosmetic: internal dependencies are `workspace:^`, which publishes as a caret, and a caret on a `0.x` version pins the minor — `@agent-surface/cli@0.21.0` asks for `@agent-surface/core@^0.20.1`, so it would have refused `core@0.21.0` and a consumer installing it alongside a newer sibling would resolve two copies of `core`. Authority identity lives in module-level `WeakMap`s, so a capability minted by one copy is rejected by the other.

This release brings all seven packages back onto one line at 0.22.0. **`compiler`, `core`, `orpc`, `react`, `testing` and `webmcp` skip 0.21.0 on npm** — there is no such version of those packages, and the gap is the repair, not a silent release. Nothing in their code changed; only `cli` did, at 0.21.0.

A new CI gate (`pnpm check:versions`) now fails when published packages diverge. It runs on the `changeset-release/main` PR — the one place the split is created and the one PR every other CI job deliberately skips — and blocks the release job, since an npm publish cannot be recalled.
