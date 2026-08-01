---
"@agent-surface/core": patch
"@agent-surface/react": patch
"@agent-surface/orpc": patch
"@agent-surface/testing": patch
"@agent-surface/webmcp": patch
"@agent-surface/cli": patch
---

Restore version lockstep, and rewrite the CLI reference page to describe the tool rather than its history.

**Lockstep.** The 0.11.0 changeset named only `core` and `cli`, so `react`, `orpc`, `testing` and `webmcp` took dependent patch bumps to 0.10.1 instead of riding to 0.11.0 — the failure `.changeset/README.md` warns about, where a release changeset gets written as a description of the diff instead of as the lockstep declaration it is. Their manifests are realigned to 0.11.0 here and this changeset carries all six to the next patch.

**Those four skip 0.11.0 on npm** (0.10.1 → 0.11.1). Nothing was published at 0.11.0 for them, so the gap is a numbering artifact of the repair, not a silent release.

**Docs.** `docs/20-cli.md` narrated how the document and the command surface reached their current shape. A reference page is for someone using the tool now; the roadmap, the decision log and RFC 21 carry the history. No code, no behaviour, no API change.
