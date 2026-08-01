---
"@agent-surface/core": minor
"@agent-surface/react": minor
"@agent-surface/orpc": minor
"@agent-surface/testing": minor
"@agent-surface/webmcp": minor
"@agent-surface/cli": minor
---

Lead `inspect` and `check` with a summary, and report the gap the coverage join cannot see.

**Both commands are now written the way they are read: summaries first, details after.**

`inspect` opens with the run — the config, the depth, the scope every count is relative to, and the scenarios about to mount — printed *before* the mounts, because all of it is known before them and they are the slow half. Then `SURFACE SUMMARY`: reach, what is callable, what the surface can actually do, the catalog's completeness, and one verdict line, instead of the bare `authored · reached · unreached` that used to close the report. The static catalog and the per-scenario tables follow as detail.

That order costs the streaming `inspect` used to do — a summary is a statement about every scenario, so it cannot be written until every scenario has mounted. A terminal is told what it is waiting for instead: the header is already on screen, and a spinner names the scenario being mounted and how far through the list it is. `check` has always collected first, and now says the same things in the same shape.

**New finding: `NEVER CALLABLE`.** Mounted by every scenario, and callable in none of them — a drawer every scenario leaves closed registers its `close` action in each snapshot and can be used in no scenario. `unreached` counts it reached, correctly, so nothing saw this before. Reported by `inspect` (and in `--json` as `neverCallable`), and deliberately not a gate: it is a judgement about your scenarios rather than a defect in the surface. It prints only when more than one scenario ran.

**Scenario tables.** `check` and multi-scenario `inspect` print one row per scenario — route, callable/disabled/hidden, rejections, and for `check` how its baseline compared. A scenario that failed to mount appears in the table with its error, rather than only at the bottom of the report.

**Every finding says what to do about it,** and a failing `check` ends with `NEXT STEPS`: the commands that clear the report, in the order worth running them.

**Fixed: a scoped `check` never named its scope.** `--scope devices` filters the catalog, the mount, and every count in the matrix, but the gate's own report said nothing about it — so `9/9 authored capabilities reached` in CI was a claim about one prefix of the codebase, reading as a claim about all of it (`AS-CLI-007`). The header now names it.

**Fixed: the domain row claimed the wrong thing at full depth.** With no `manifest` configured it read "not analyzed at static depth" while running at full depth. "Nobody looked" and "there is nothing to look at" are different statements and now read differently.

Committed baselines, `.agent-surface/` file formats and exit codes are unchanged. `inspect --json` gains `neverCallable`; every existing key keeps its shape.
