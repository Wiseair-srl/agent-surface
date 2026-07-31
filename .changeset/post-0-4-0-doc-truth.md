---
"@agent-surface/core": patch
"@agent-surface/react": patch
"@agent-surface/orpc": patch
"@agent-surface/testing": patch
"@agent-surface/webmcp": patch
---

Documentation truth pass after 0.4.0. No behavior change in any package.

0.4.0 shipped D31 alone, which left several published statements false:

- **`descriptionIncludesState` and `snapshotMergesContextualNote` JSDoc** said the `true` default lasts "for one minor". It has now lasted three (0.2, 0.3, 0.4). This text ships in the `.d.ts`, so hosts read it in their editor — it now says "default through 0.4; flips in 0.5".
- **[19 §C4](https://github.com/Wiseair-srl/agent-surface/blob/main/docs/19-catalog-scale-rfc.md)** scheduled the D28 flags as introduce-0.2 → flip-0.3 → remove-0.4. D28 landed in 0.3, and 0.4 shipped without the flip, so the live schedule is **flip in 0.5, remove in 0.6**. The accepted RFC answer is annotated rather than rewritten; the record of what was decided stays intact.
- **[02 §budgets](https://github.com/Wiseair-srl/agent-surface/blob/main/docs/02-architecture.md#bundle-and-performance-budgets-first-measured-baselines)** claimed the 19 kB `core` budget returns at 0.5. Removal is 0.6, and flipping a default frees nothing regardless — both branches stay in the bundle while the flags exist.
- **README and [12](https://github.com/Wiseair-srl/agent-surface/blob/main/docs/12-roadmap.md)** still described 0.4 as the unshipped "adoption and enforcement" milestone and pinned the packages at 0.3.0. v0.4 is recut as shipped; the enforcement work moves to v0.5.

The D28 default flip is **not** in this release — it is a deliberate breaking change for any host that sets neither flag, and it needs a migration note rather than a patch bump.
