---
"@agent-surface/cli": minor
"@agent-surface/core": minor
"@agent-surface/react": minor
"@agent-surface/orpc": minor
"@agent-surface/testing": minor
"@agent-surface/webmcp": minor
---

Answer the other question: which authored capabilities does no scenario reach?

`inspect` answered *what can an agent do on this page right now* and was read as answering *did we author something no scenario ever reaches* — a question nothing in the repository could compute. The two got conflated because the CLI inherited "the catalog is undiscoverable" from "the projection is dynamic". True of the projection: availability, policy outcome and binding are functions of unbounded application state. False of the catalog: `type` is a string literal, capability names are object keys, so `view:devices.table.sort` is fully determined by source text.

**`agent-surface capabilities` — a static inventory** (`AS-COVER-001…003`, `AS-COVER-006`, D35). Reads the TypeScript program over your own `tsconfig`: no Vite dev server, no jsdom, no scenarios, no mount. One entry per authored capability, each carrying `resolution: "static" | "partial" | "unresolved"` and where to go and read it. A call site the extractor cannot understand is emitted **with its file, line and the construct that defeated it** — never dropped — and the command exits non-zero until you fix it or pass `--allow-unresolved`. A partial understanding of a codebase that reports itself as complete is the exact failure this exists to remove.

It reads code and creates nothing. No DOM scanning, no annotation generation, no runtime effect. The inventory lives in `@agent-surface/cli`, which no adapter imports and no application ships, and `AS-COVER-006` pins it out of the package root adapters import, mirroring `AS-EXPLAIN-004`.

**`agent-surface coverage` — authored minus reached** (`AS-COVER-004…005`, D36). Joins the inventory against the union of every scenario's *explanation* and reports `unreached`, `undeclared` and `unresolved`. The explanation, not the snapshot: a capability a policy hid **was** reached — a scenario mounted it and the policy made a deliberate decision about it — and counting those as gaps would have made the example app's signed-out scenario contribute eleven false ones. Adoption ratchets rather than gates, through a committed `.agent-surface/coverage-allow.json`; an entry that is no longer unreached fails the command, so the list shrinks and cannot silently rot. Exit codes follow `AS-CLI-002`.

**`cli`: the commands stopped asserting completeness they could not back** (`AS-CLI-006…007`, D37).

- **Rejected registrations are reported.** A duplicate `(type, instanceId)` or an `onRegister` rejection yields a dead handle that reaches neither the snapshot (it never registered), nor the explanation (`explainSurface()` iterates active registrations), nor any baseline — and its only diagnostic goes through `devError`, which prints nothing under the `environment: "test"` the documented config shape builds. Copy-paste a component `type` and a capability disappeared with no output anywhere. The registry always emitted `component-rejected`; the collector now reads it, renders it, and carries `rejections` as an always-present array in `--json`.
- **Counts name what they are relative to.** The scenario always, and the scope when one is active — `--scope` filters the snapshot *and* the explanation, and nothing on screen said so.
- **`hidden` prints unconditionally.** It was already computed on every run. Suppressing it outside `--explain` meant a policy-emptied surface rendered as `0 callable, 0 visible-disabled` under the words *nothing is registered*, over eleven capabilities that authority had hidden. The attribution still needs `--explain`; only the count moved.
- **A green `check` names the scenarios it compared**, because it means "the surface did not change *in these scenarios*", never "the surface did not change".

Still not detectable by anything here: a UI affordance that was never registered. There is no capability, no call site and no registration, so there is nothing to find — human review of the diff remains the only gate, and a green `coverage` must not be read as covering it.

`core`, `react`, `orpc`, `testing` and `webmcp` carry no code change in this release; they are versioned along with the rest to keep the six packages on one line.
