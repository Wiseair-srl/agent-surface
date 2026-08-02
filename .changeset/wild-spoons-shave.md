---
"@agent-surface/cli": minor
---

One report, one look, whichever command drew it (`AS-CLI-014`, D39).

The renderer was chosen at each call site rather than once for the run, so three
of those choices were never made: `check` and `snapshot` drew no terminal UI at
all — a `check` on a real repository was seventeen silent seconds and then a wall
of plain text — `inspect` printed its static catalog and its mount failures as
raw text in the middle of a drawn report, and a single report carried two
different text columns because each block sized its own label field.

Commands no longer render. They build a report model — blocks, tables, findings,
notes, next steps — and one presenter draws it:

- **Ink or plain text, decided once, per stream.** `check` and `snapshot` now
  draw in a terminal, with the spinner naming the scenario being mounted; both
  stay plain wherever the report is actually read — piped, `CI`, `NO_COLOR`,
  `--plain` (`AS-CLI-003`, unchanged). A drawn run whose stderr is redirected
  writes readable text to the file rather than cursor escapes.
- **One label grid** across every block of every command, widened 12 → 14
  columns. `check`'s health matrix therefore sits two columns right of where it
  did. Human output only — no committed artifact changed.
- **`snapshot` opens with the run it describes** (`AS-CLI-013`), the one command
  that changes committed files having been the only one that never said what it
  was pointed at, and lists what it wrote as a table instead of `wrote …` lines.
- **`init` reports through the same blocks** `inspect --depth static` uses.
- Mount failures and the "no coverage verdict" note are findings like any other,
  so they are drawn like any other rather than printed as raw text mid-report.
- The static catalog's footer no longer promises allowlist keys behind
  `--detail`; they are printed in full above it, and always were.
