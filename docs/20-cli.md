# CLI

`@agent-surface/cli` compiles the production Vite graph and works with its canonical capability contract.

```bash
pnpm exec agent-surface inspect
pnpm exec agent-surface snapshot
pnpm exec agent-surface check --base origin/main --format github
```

## Repository contract

The compiler output is the complete repository inventory. CLI commands do not execute the application or infer capability reach from runtime state. If the production graph cannot be proven complete, the command exits `2`.

## Artifact

`snapshot` writes `.agent-surface/contract.json` by default. Commit this file as generated, reviewable output; do not edit it manually.

The contract contains:

- compiler and format versions;
- production targets;
- one row per declaration and capability;
- descriptions, schemas, effects, confirmation, policies, tags, and origin;
- declaration, capability, sidecar, and complete-manifest hashes;
- `completeness.status: "proven"`.

It contains no timestamps, absolute checkout paths, runtime registration ids, handlers, availability, or bound values. Identical source, lockfile, Vite configuration, and compiler version produce identical bytes across checkout paths.

## External contracts

A dependency contributes capabilities only with explicit approval, keyed by package name and digest — see [external contract authorization](02-architecture.md#external-contract-authorization). Approve one from the command line:

```bash
pnpm exec agent-surface check --allow @vendor/plugin=<sha256>
```

`--allow` is repeatable, and the argument must be `<package>=<sha256>` or the command exits `2` rather than compiling with the approval dropped. A build that finds an unapproved contributor fails and prints the entry to add, digest included; an approved contributor that changed fails with both digests. There is no flag that skips the check.

For anything beyond a couple of dependencies, keep the list in the Vite config as `agentSurface({ externalContracts: { allow: [...] } })` so it is reviewed with the rest of the build.

## `inspect`

```bash
pnpm exec agent-surface inspect [--base <ref>] [--verbosity <level>] [--format <format>]
```

Compiles the current graph and displays the capability inventory plus source-to-snapshot drift. With `--base`, it also displays contract drift from the selected Git ref. Findings do not change exit `0`; compilation and completeness failures exit `2`.

The default view is compact: a headline with the size of the surface, how much of it is gated, and the snapshot's integrity, then the inventory as one flat table. Drift rows appear only when there is drift — an explicit `--base` always gets its answer, even when that answer is no changes.

Columns are `CAPABILITY`, `KIND`, `EFFECT`, `REACH`, `CONFIRM`, `POLICIES`. A capability that declares no confirmation or policy shows `—` rather than an empty cell. `REACH` is derived from the effect — `read` and `local-state` are `low`, `navigation` and `server-query` are `medium`, `server-mutation`, `external-side-effect` and `destructive` are `high` — and it is printed as a word, not signalled by colour alone, so a pipe or a CI log carries the same grade a terminal does. At a terminal, colour repeats the words: effects cool when they read and warm when they write, grades green through red.

`--verbosity` scales the same view rather than swapping layouts:

- `min` — the headline alone: counts, gates, integrity.
- `normal` — the default described above.
- `detail` — adds provenance (contract hash, compiler, snapshot path), groups capabilities under the declaration that owns them — the declaration written once as a heading rather than repeated on every row — and prints each capability's description and tags beneath its row. `--detail` is the shorthand.

The view closes by saying what it cannot know: the contract is what production code can declare, and `CONFIRM` and `POLICIES` are declarations. Whether a policy admits, denies, or hides a capability depends on the actor, input, and context of a real invocation, which no CLI command performs.

Use `inspect` for local review and diagnosis.

## `snapshot`

```bash
pnpm exec agent-surface snapshot [--output <path>]
```

Writes the canonical compiler result. It exits `2` without writing when a declaration is dynamic, non-serializable, unsupported, unpinned, or otherwise incomplete.

Run it whenever source changes intentionally alter the contract.

## `check`

```bash
pnpm exec agent-surface check \
  --base origin/main \
  --policy all \
  --format github
```

`check` performs two independent comparisons:

1. **Integrity:** current compiled source against this branch's committed snapshot.
2. **PR drift:** this branch's snapshot against `--base`.

Refreshing the snapshot fixes integrity but does not hide PR drift.

Contract changes are classified as:

- **widening:** new declaration, capability, or target; removed policy; reduced confirmation; lower effect or risk posture;
- **narrowing:** removed declaration, capability, or target; added policy; stronger confirmation or risk posture;
- **neutral:** descriptions, schemas, tags, wire metadata, moves, and other structural changes.

`--policy all|widening|narrowing|neutral|none` selects which findings fail the command. It never removes rows from output.

`check` leads with the verdict and the drift behind it. Add `--verbosity detail` (or `--detail`) to print the full inventory underneath, in the same grouped form `inspect` uses — the reason to ask a gate for detail is to read what it gated. `--verbosity min` keeps only the verdict and the per-section counts. When integrity fails in the human format, the command to run next is printed on stderr, where it survives a piped report.

## Exit codes

| Code | Meaning |
|---:|---|
| `0` | View complete; no selected failure |
| `1` | Integrity failure or selected PR-policy finding |
| `2` | Compiler, graph, Git-base, contract, or completeness failure |

## Output

Use `--format human|json|md|github`. `md` and `markdown` are the same format — the sibling [orpc-agent CLI](https://orpc-agent.dev/reference/cli) spells it `md`, and both CLIs accept both.

- `json` is canonical machine output (`--json` is the alias). It carries no checkout path, so two machines that compiled the same source produce the same bytes.
- `github` and `md` are CI-friendly renderings of the same report model.
- interactive `human` output is drawn with Ink. It shows the same blocks, columns, and words as the plain renderer; colour repeats a word — the effect, the grade, the gate — and never carries a fact alone.
- pipes, CI, `NO_COLOR`, and machine formats produce deterministic plain text. `--plain` skips the drawn view and still paints when attached to a terminal.
- `--verbosity` scales the `human` renderings only. `json` already carries every field `detail` adds.

A package manager forwards the `--` that separates its own flags from the script's, so both spellings reach the CLI intact:

```bash
pnpm surface:inspect --verbosity detail
pnpm surface:inspect -- --verbosity detail
```

## Recommended CI command

```bash
pnpm exec agent-surface check \
  --base origin/main \
  --policy all \
  --format github
```

Pair this repository-contract check with [runtime tests](08-testing.md). The compiler proves what production code can declare; tests prove how mounted capabilities behave.
