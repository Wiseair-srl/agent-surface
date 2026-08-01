---
"@agent-surface/core": patch
"@agent-surface/react": patch
"@agent-surface/orpc": patch
"@agent-surface/testing": patch
"@agent-surface/webmcp": patch
"@agent-surface/cli": patch
---

Fix a static-catalog soundness hole (#29), resolve wrapper hooks (#31), add per-entry acceptance for unread call sites (#30), restore version lockstep, and rewrite the CLI reference page to describe the tool rather than its history.

**A spread of members no longer disappears (#29).** `useAgentComponent({ type: "x", ...buildMembers() })` was dropped from the catalog *and* from the unread call sites, so the count claimed a completeness it did not have — the one failure the static half exists to prevent. The extractor now resolves what a spread can contribute: a written-out key set with no capability group stays quiet (`...(props.instance ? { instanceId } : {})`, the shape every example uses), and anything it cannot read is reported unread. This holds even when a literal `observations` alongside the spread resolved perfectly, because that half says nothing about the `actions` the spread may add.

Repositories using that shape will see new `UNREAD CALL SITES` entries, and `check` will fail until they are fixed or `--allow-unresolved` accepts them. That is the point: those capabilities were always missing from the count.

**Lockstep.** The 0.11.0 changeset named only `core` and `cli`, so `react`, `orpc`, `testing` and `webmcp` took dependent patch bumps to 0.10.1 instead of riding to 0.11.0 — the failure `.changeset/README.md` warns about, where a release changeset gets written as a description of the diff instead of as the lockstep declaration it is. Their manifests are realigned to 0.11.0 here and this changeset carries all six to the next patch.

**Those four skip 0.11.0 on npm** (0.10.1 → 0.11.1). Nothing was published at 0.11.0 for them, so the gap is a numbering artifact of the repair, not a silent release.

**Wrapper hooks resolve one hop up (#31).** `useAgentComponent({ type })` where `type` is a parameter now resolves from the wrapper's call sites, emitting one capability set per string literal — the same one-hop budget the extractor already spends going sideways to a same-module `const`. A single shared wrapper accounted for 91% of one real application's surface, all of it previously invisible. A call site is resolved only when it provably calls *that* wrapper (same file, or an import resolving to its file); anything else stays unread, because a fabricated catalog entry is worse than a missing one. Resolution is per call site, so literals resolve while non-literal callers are reported.

**Per-entry acceptance for unread call sites (#30).** `.agent-surface/unresolved-allow.json` mirrors `coverage-allow.json`: listed sites stop failing `check`, and a site the extractor can now read fails so the list shrinks. The key is `file#reason` — not the line, which churns on unrelated edits, and not the note, which is prose that gets reworded. `inspect` prints the key under every unread entry. `--allow-unresolved` remains the blanket dial and the two compose.

**Docs.** `docs/20-cli.md` narrated how the document and the command surface reached their current shape. A reference page is for someone using the tool now; the roadmap, the decision log and RFC 21 carry the history. No code, no behaviour, no API change.
