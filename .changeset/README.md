# Changesets

Release flow (mirrors orpc-agent):

1. Land a change → `pnpm changeset` → pick bumped packages + semver level, write the note.
2. CI's release job (changesets/action) opens/updates a "chore: version packages" PR.
3. Merging that PR versions the packages and publishes to npm (`pnpm release`).

## Lockstep versioning while we are pre-1.0

All seven `@agent-surface/*` packages ship on the same version. That is achieved by **listing every package in the release's changeset**, not by the `linked`/`fixed` config — both of those escalate a `minor` to `1.0.0` for a group of `0.x` packages, which would announce a stability the [roadmap](../docs/project/12-roadmap.md) says we have not earned.

Two settings keep that working; do not "clean them up" without re-reading this:

- `linked: []` — grouping is done by the changeset file, per above.
- `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH.onlyUpdatePeerDependentsWhenOutOfRange: true` — by default changesets majors *any* package that peer-depends on something being bumped. `orpc` and `testing` peer-depend on `react`, so every release would major them for a change they did not make.

Intra-repo peer ranges are therefore deliberately loose (`@agent-surface/react: ">=0.1.0"`, not `workspace:^`): a caret pins the minor on `0.x`, so every sibling release would read as a peer-range break. The packages are released together; the range says so. Revisit at 1.0, when caret ranges start meaning what they normally mean.

### Why the lockstep is load-bearing, not tidiness

`dependencies` use `workspace:^`, which publishes as a caret — and a caret on `0.x` pins the *minor*. A package that ships alone therefore asks for a sibling range its siblings have already left: `@agent-surface/cli@0.21.0` depends on `@agent-surface/core@^0.20.1`, which accepts no `core` at `0.21.0` or above. Install it beside a newer sibling and the tree resolves **two copies of `core`** — and authority identity lives in module-level `WeakMap`s, so a capability minted by one copy is rejected by the other. The split is not a cosmetic version gap; it is a broken install.

### The failure mode, and the gate

The lockstep has broken five times — 0.6.0, 0.11.0, 0.14.0, post-0.17.1, and 0.21.0 — always the same way: a changeset naming *the packages that were edited* instead of *all seven*. The pull is strong because it is what the tool is designed for and what the diff suggests. **The frontmatter of a release changeset is a lockstep declaration, not a description of the diff.**

`pnpm check:versions` now fails when published packages diverge. In CI it is the `versions` job, deliberately without the `changeset-release/main` guard the other jobs carry — the split is created by `changeset version`, so the version PR is the only place to catch it, and that is the very PR the guard skips. It also blocks `release`, because an npm publish cannot be recalled.

If it goes red: raise the laggards' `version` by hand to the highest line *first*, then let one grouped changeset naming all seven carry them to the next number. Those packages skip a number on npm — harmless, but say so in the changeset so the gap does not read as a silent release.

Check what a release will produce before merging the version PR:

```bash
pnpm changeset status --verbose
pnpm check:versions
```
