---
"@agent-surface/core": minor
"@agent-surface/compiler": minor
"@agent-surface/cli": minor
"@agent-surface/react": minor
"@agent-surface/orpc": minor
"@agent-surface/testing": minor
"@agent-surface/webmcp": minor
---

The rendered view shows the contract again, and `--` no longer ends the command.

Two defects, one visible only in a terminal and one only through a package
manager, met in the same command.

**The drawn view had no inventory.** `inspect` renders through Ink when stdout
is a TTY, and that renderer printed four summary lines: hash, completeness,
capability count, integrity. The plain renderer behind `--plain`, a pipe or CI
printed the whole repository contract, and [docs/20-cli.md](../docs/20-cli.md)
described `inspect` as displaying the capability inventory. So the documented
behaviour was reachable only by redirecting the output, and a developer running
the command the ordinary way was told *36* and never which 36 (`AS-CLI-001`,
returned to `implemented`). The same gap made a failing interactive `check`
report `Integrity stale` without a single line saying what had drifted; the
change rows existed in every other renderer.

Both renderers now derive from one layout, and it leads with the answer:
how large the surface is, how it splits by kind, and how much of it is gated.
The hash and the compiler version are provenance and sit below it rather than
occupying the first line a reader sees.

The inventory is a labelled table — `CAPABILITY`, `KIND`, `EFFECT`, `REACH`,
`CONFIRM`, `POLICIES` — grouped by the declaration that owns each capability, a
heading written once instead of the same `contracts.ts#allInvoicesTableContract`
repeated down ten rows. Three columns were previously unlabelled, so a reader
had to infer that `action` was a kind and `local-state` an effect. A capability
declaring no confirmation or policy now shows `—`, because a column that
vanishes when empty stops being a column.

`REACH` grades the effect ladder — `read` and `local-state` low, `navigation`
and `server-query` medium, `server-mutation`, `external-side-effect` and
`destructive` high. It is printed as a word. The first version of this graded
effects by colour in the drawn view alone, which put the signal in the one
channel a pipe, a CI log and `--plain` cannot read; colour now repeats the word
instead of carrying it.

The view also closes by saying what it cannot know: these are declarations
compiled from the production graph, not a transcript of a run, and whether a
policy admits, denies or hides a capability depends on an actor and an input
that no CLI command supplies. A tool that reports gates should say when it is
reporting an intention rather than an outcome.

The snapshot path is shown relative to the root the user passed rather than as
an absolute checkout path, and drift rows are coloured by classification.

**`--detail`** adds each capability's description and its tags. The
descriptions were already compiled into the contract and already in `--json`;
nothing in the human output had ever shown them. `--detail` also prints the
inventory under `check` and `snapshot`,
which otherwise lead with a verdict and leave it out — the reason to ask a gate
for detail is to read what it gated.

**`--` ended the command.** `pnpm run <script> -- --plain` forwards the
separator, and `parseArgs` turns everything after it into positionals, so the
flag arrived as a second command and the run died with
`invalid command inspect` before compiling anything. That is the pass-through
idiom npm and pnpm both document. The first separator is now dropped — this CLI
takes no literal operands — and a genuinely extra positional still exits `2`.

Help is grouped into compilation, contract and output rather than one flat list
of twelve, and carries examples.

`json`, `github` and `markdown` are unchanged, byte for byte. Presentation
inputs are deliberately kept out of the report model: a checkout path in
canonical machine output would differ between two machines that compiled the
same source.

No functional change in `core`, `compiler`, `react`, `orpc`, `testing` or
`webmcp`; they are named here to hold lockstep
([.changeset/README.md](./README.md)).
