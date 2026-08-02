# CLI — compiled repository contract

The CLI reads the production Vite graph through `@agent-surface/compiler`. It does not mount React, run scenarios, inspect a tsconfig-shaped approximation, or accept allowlists. If the compiler cannot prove the graph, the command exits `2`.

```bash
agent-surface inspect
agent-surface snapshot
agent-surface check --base origin/main --format github
```

## Artifact

`snapshot` writes `.agent-surface/contract.json` by default. Commit it. It is generated output and the PR review ledger, never an authored registry.

The contract contains:

- compiler/format version and production targets;
- one row per `declarationId + capabilityId`;
- descriptions, schemas, effect, confirmation, policy attachments, tags and origin;
- content hashes for each declaration and the complete manifest;
- pinned dependency/remote sidecar digests;
- `completeness.status: "proven"`.

Ordering and paths are canonical. There are no timestamps, absolute paths, registration ids or runtime values. Equal source, lockfile, build config and compiler version produce equal bytes across checkout paths (`AS-COMPILER-002`).

## `inspect`

Compiles the current graph, lists the repository inventory, and shows source-to-snapshot drift. `--base <ref>` also shows Git-base drift. Findings never change its exit `0`; compilation/completeness failure exits `2`.

## `snapshot`

Writes compiler output only. It exits `2` before writing if any declaration is dynamic, unserializable, unsupported, unpinned or otherwise incomplete.

## `check`

Performs two independent comparisons:

1. **Integrity:** current compiled source equals this branch's snapshot.
2. **PR drift:** this branch's snapshot versus `--base`, even after refreshing the snapshot.

PR drift is always rendered. `--policy all|widening|narrowing|neutral|none` changes exit policy only; it never hides rows.

Classification:

- widening: added declaration/capability/target, removed policy, reduced confirmation, or lowered declared effect/risk;
- narrowing: removed declaration/capability/target, added policy, or stronger confirmation/risk posture;
- neutral: descriptions, schemas, tags, wire metadata, moves and other structural changes.

Exit codes are stable:

- `0`: clean/view complete;
- `1`: deterministic integrity or selected PR-policy finding;
- `2`: compiler, graph, Git-base, contract or completeness failure.

## Output

`--format human|json|github|markdown`. JSON is canonical machine output. GitHub/Markdown/human views derive from the same diff model (`AS-CLI-016`). Interactive human output uses Ink; pipes, CI, `NO_COLOR`, `--plain`, and machine formats are byte-stable text.

## Removed architecture

There is no config mount, scenario, depth, scope, coverage join, runtime baseline, unresolved bucket, allowlist, jsdom or `init`. Runtime behavior testing remains under `@agent-surface/testing`; it is not repository inventory.
