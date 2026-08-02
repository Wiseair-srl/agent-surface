---
"@agent-surface/core": minor
"@agent-surface/react": minor
"@agent-surface/orpc": minor
"@agent-surface/testing": minor
"@agent-surface/webmcp": minor
"@agent-surface/cli": minor
---

Restores lockstep versioning: all six packages ship on 0.15.0.

0.14.0 released `@agent-surface/cli` alone, because its changeset named only the
package whose code had changed. The frontmatter of a release changeset is a
lockstep declaration rather than a description of the diff
([.changeset/README.md](../.changeset/README.md)), so the other five were left
behind at 0.13.0 — the same failure, and the same cause, as 0.6.0 and 0.11.0.

`core`, `react`, `orpc`, `testing` and `webmcp` were carried to 0.14.0 in the
manifests and are published here at **0.15.0**; they have **no 0.14.0 on npm**.
That gap is the repair, not a silent release: nothing shipped in it, and
`@agent-surface/cli@0.14.0` — which did ship, and works — depends on
`^0.13.0` of its siblings, so no installed tree was ever inconsistent.

No functional change in any of the five.
