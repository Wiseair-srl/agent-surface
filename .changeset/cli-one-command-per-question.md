---
"@agent-surface/cli": minor
"@agent-surface/core": minor
---

**CLI: five commands became four, and the gap between what you author and what a scenario reaches now fails the gate.**

`capabilities` and `coverage` are gone. They split the command surface along an implementation seam — *does this boot a TypeScript program? does it need jsdom?* — rather than along a question anybody has, and the cost was a hole in CI: `check` gated on drift alone and printed a line saying that capabilities no scenario mounts were `coverage`'s question. Under a green tick, nobody reads the second line.

```bash
agent-surface init                  # read the codebase, then scaffold a config
agent-surface inspect [scenario]    # what an agent can reach, and what it cannot
agent-surface snapshot [scenario]   # write/refresh the committed baseline
agent-surface check [scenario]      # fail on drift, or on a capability no scenario reaches
```

**Migrating.** `capabilities` → `inspect --depth static`. `coverage` → nothing: the verdict is part of `inspect`, `snapshot` and `check` now. Both were removed rather than aliased; naming either prints where its answer went.

- **`--depth static|runtime|full`** picks which halves to compute, `full` by default. `static` needs no scenarios and survives an app that will not mount; `runtime` skips the TypeScript program on a repository wide enough to feel it.
- **`check` fails on four classes**, not one: drift, a missing baseline, an unreached capability, an unread call site. `.agent-surface/coverage-allow.json` ratchets the third; `--allow-unresolved` accepts the fourth. `inspect` reports all four and exits `0` — a viewer that sometimes fails is a viewer nobody pipes.
- **Exit `2` widened** from *usage error* to *could not run*, matching `orpc-agent`: an unknown scenario, an unreadable config, a bad `--depth`, or a scenario whose mount threw. CI has to tell "the surface changed" from "the tool never loaded the app".
- **`inspect` renders a table**, laid out from the content rather than the terminal width. `--detail` keeps the old paragraphs; `--explain` and `--schemas` imply it. Hidden capabilities print as rows without `--explain`, and a hidden row carries no availability reason — authority hides, state discloses, and the two must not look alike.
- **`inspect --json` changed shape**: `{ depth, catalog, scenarios, failures, coverage }`, each half `null` when the depth did not compute it.

**Two defects fixed.** `coverage --scope devices` filtered the mount but not the catalog, reporting `app.navigation` capabilities as ones "no scenario mounts" over two that every scenario mounts — the join now uses core's own `matchesScope`, newly re-exported from `@agent-surface/core/explain` (off the agent-facing root). And a scenario that failed to mount still produced a verdict in which everything it would have surfaced counted as unreached; there is now no verdict at all in that case, and the failed scenarios are named.
