# Changesets

Release flow (mirrors orpc-agent):

1. Land a change → `pnpm changeset` → pick bumped packages + semver level, write the note.
2. CI's release job (changesets/action) opens/updates a "chore: version packages" PR.
3. Merging that PR versions the packages and publishes to npm (`pnpm release`).

All `@agent-surface/*` packages are version-linked.
