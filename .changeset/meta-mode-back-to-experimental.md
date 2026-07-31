---
"@agent-surface/core": minor
"@agent-surface/react": minor
"@agent-surface/orpc": minor
"@agent-surface/testing": minor
"@agent-surface/webmcp": minor
---

`mode: "meta"` returns to **Experimental** (D29). No behavior change — this is a stability label, and every conformance requirement that gated the mode still passes.

It was Supported from 0.2 through 0.6, graduated on `AS-META-001…005`: a model scope narrows the configured floor, a disjoint scope yields empty, a truncated payload is marked and still a valid snapshot, `surface_act` keeps direct-mode confirmation and staleness semantics, and tool-block size is invariant in the number of capabilities.

Those five pin what the mode does *differently* from `direct`. None of them reaches the three verbs' own envelope — and that is where 0.6 found two defects, both against a live model, both making `meta` materially less reliable than `direct` for the same capabilities:

- `surface_act.input` was the only untyped property in the block, so a provider's constrained decoder had nothing to constrain and models fell back to the `function_call.arguments` prior (`AS-META-008`);
- `required` and `additionalProperties: false` were declared on the verb schemas and never enforced, so a missing `capabilityId` came back as `EXECUTION_FAILED {retry:"no"}` — a caller's mistake reported as an internal defect (`AS-META-007`).

Two protocol-level defects in one minor, in a part of the mode no requirement covered, is not what a supported label should absorb. A suite pinning a mode's distinguishing behaviors is not evidence its contract has settled.

**What this means for hosts.** Nothing breaks: `mode: "meta"` works exactly as in 0.6, and the pinned behaviors stay under test. Read the marker as *"opt in, and expect the envelope to move"* — pin the version and re-read [09 §meta-tools-mode](https://github.com/Wiseair-srl/agent-surface/blob/main/docs/09-adapters.md#meta-tools-mode) on upgrade. It remains the library's only answer for a catalog that cannot fit a provider tool block; that cost was weighed when the marker went back on, not overlooked.

Graduation is re-earnable: envelope-level requirements that hold across a release, plus a host running it in production.

**Lockstep versioning is realigned.** 0.6.0 released `core` alone, against the rule that every `@agent-surface/*` package ships on the same version, so `react`, `orpc`, `testing` and `webmcp` sat at 0.5.1. All five are 0.7.0 from here; those four skip 0.6.0 on npm, which was never published for them. Nothing about their contents changed in that gap — the skip is bookkeeping, not a silent release.

Also in this release, a documentation truth pass — published statements that had gone stale: package versions and test/requirement counts in the README, the roadmap's missing v0.6 entry (0.6.0 shipped D32, not the enforcement work its slot described), and `15-completeness-review.md` still calling D25 "specified, deliberately unimplemented" three releases after 0.2 implemented it.
