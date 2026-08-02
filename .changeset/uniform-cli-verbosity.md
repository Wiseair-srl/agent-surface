---
"@agent-surface/cli": minor
---

Uniform the CLI with orpc-agent and add `--verbosity`.

`inspect` now defaults to a compact view: a headline with counts, gates and snapshot integrity, then one flat colour-coded table — effect and reach painted on the same scale the orpc-agent CLI uses (reads cool, writes warm, destructive red), in both the drawn and the plain renderer. Drift sections print only when there is drift; an explicit `--base` always gets its answer.

`--verbosity min|normal|detail` scales every human view: `min` stops at the headline (for `check`, the verdict and per-section counts), `detail` restores the grouped-by-declaration inventory with descriptions, tags, provenance fields and the full caveat. `--detail` remains as the shorthand for `--verbosity detail`.

`--format` additionally accepts `md` as a spelling of `markdown`, matching orpc-agent. A failing integrity check now prints the snapshot command to run on stderr. Canonical `--json` output is unchanged.
