# Changesets

Release flow (mirrors orpc-agent):

1. Land a change → `pnpm changeset` → pick bumped packages + semver level, write the note.
2. CI's release job (changesets/action) opens/updates a "chore: version packages" PR.
3. Merging that PR versions the packages and publishes to npm (`pnpm release`).

## Lockstep versioning while we are pre-1.0

All `@agent-surface/*` packages ship on the same version. That is achieved by **listing every package in the release's changeset**, not by the `linked`/`fixed` config — both of those escalate a `minor` to `1.0.0` for a group of `0.x` packages, which would announce a stability the [roadmap](../docs/project/12-roadmap.md) says we have not earned.

Two settings keep that working; do not "clean them up" without re-reading this:

- `linked: []` — grouping is done by the changeset file, per above.
- `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH.onlyUpdatePeerDependentsWhenOutOfRange: true` — by default changesets majors *any* package that peer-depends on something being bumped. `orpc` and `testing` peer-depend on `react`, so every release would major them for a change they did not make.

Intra-repo peer ranges are therefore deliberately loose (`@agent-surface/react: ">=0.1.0"`, not `workspace:^`): a caret pins the minor on `0.x`, so every sibling release would read as a peer-range break. The packages are released together; the range says so. Revisit at 1.0, when caret ranges start meaning what they normally mean.

Check what a release will produce before merging the version PR:

```bash
pnpm changeset status --verbose
```
