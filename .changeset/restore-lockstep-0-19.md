---
"@agent-surface/core": minor
"@agent-surface/compiler": minor
"@agent-surface/cli": minor
"@agent-surface/react": minor
"@agent-surface/orpc": minor
"@agent-surface/testing": minor
"@agent-surface/webmcp": minor
---

Restores lockstep versioning: all seven packages ship on 0.19.0.

0.18.0 released `@agent-surface/core`, `@agent-surface/compiler` and
`@agent-surface/cli` alone, because the two changesets behind it
(`olive-hoops-shave.md`, `tall-donkeys-attack.md`) each named only those
three packages. The frontmatter of a release changeset is a lockstep
declaration rather than a description of the diff
([.changeset/README.md](../.changeset/README.md)), so `react`, `orpc`,
`testing` and `webmcp` were left behind at 0.17.1 — the same failure, and
the same cause, as 0.6.0, 0.11.0 and 0.14.0.

`react`, `orpc`, `testing` and `webmcp` were carried to 0.18.0 in the
manifests and are published here at **0.19.0**; they have **no 0.18.0 on
npm**. That gap is the repair, not a silent release: nothing shipped in it.

No functional change in any of the four.
