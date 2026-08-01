# 21 — Surface Coverage RFC (P1)

> [!IMPORTANT]
> **Status: Accepted and implemented.** Raised against 0.7 after an audit of what `agent-surface inspect` can and cannot tell a developer. All three corrections are settled as decision records **D35–D37** in [Decisions](13-open-questions.md) and implemented in `@agent-surface/cli`, with requirements `AS-COVER-001…006` and `AS-CLI-006…007` conformance-tested in `packages/cli/test/coverage.test.ts` and `packages/cli/test/cli.test.ts`. The normative command contract now lives in [CLI §capabilities](../20-cli.md#capabilities), [CLI §coverage](../20-cli.md#coverage) and [CLI §inspect](../20-cli.md#inspect); this document is the rationale, not a second source of truth.
>
> **The security model is untouched.** No correction here creates a runtime exposure path, and none of them changes `snapshot()`, `invoke`, or any adapter. The new artifact is a developer projection in the same sense as `explainSurface()` — see [§what this does not change](#what-this-rfc-does-not-change), which is the section to read first if the words "automatic discovery" set off an alarm. It should.
>
> **Superseded in part by [§amendment](#amendment--the-command-cut-was-wrong-d38) (D38, 0.11.0):** the analysis holds, the two new commands do not — `capabilities` and `coverage` were folded into `inspect`/`check` behind a `--depth` dial.
>
> **What shipped differently from the proposal below:** `undeclared` holds `domain:` ids apart from genuinely-undeclared ones, since the inventory never claimed that plane and filing them as "no static origin" would report a stated boundary as a defect. The `inspect` header carries the scenario and scope but *not* the authored denominator — that would force a TypeScript program boot into every `inspect`, and the denominator is `coverage`'s to report. Descriptions concatenated from adjacent string literals resolve as `static`, not `partial`. Of the five open questions, four are resolved (see [below](#unresolved-questions)); the granular-hook one became [OQ-13](13-open-questions.md#part-b--genuinely-open-questions).

---

## Motivation

`agent-surface inspect` answers one question well: *what can an agent do on this page right now*. It cannot answer the other one a developer has: *did we author something that no scenario ever reaches*.

Run it on the example app and the header reads — this and every other output quoted in this section is the behaviour **before** the corrections below, kept as the record of what prompted them:

```text
scenario admin  route /devices
9 callable, 2 visible-disabled
```

Nine of how many? Not eleven: `--explain` will say `0 hidden` here, so the *registered* total is knowable. The missing denominator is the *authored* one, and nothing in this repository produces it. The number is relative to one hand-written scenario, and the line does not say so.

### The conflation

[CLI §why this isn't `--entry ./router.ts`](../20-cli.md#why-this-isnt---entry-routerts) opens with an argument that is correct and load-bearing:

> A server router is a static export… A presentation surface is not: it is a projection of which components are currently mounted…

True of the **projection**. Not true of the **catalog**. Look at a real call site (`examples/devices-app/src/app/DevicesTable.tsx`):

```tsx
useAgentComponent({
  type: "devices.table",
  ...(props.instance ? { instanceId: props.instance } : {}),
  description: "Table of devices matching the active filters",
  observations: { readState: observation({ description: "Visible rows, current selection, current sorting", … }) },
  actions: { selectRows: action({ … }), sort: action({ description: "Change the table sorting", effect: "local-state", idempotent: true, … }) },
});
```

`type` is a string literal. Capability names are object keys. `description`, `effect` and `idempotent` are literals. The identity `view:devices.table.sort` is fully determined by source text. The only dynamic part is `instanceId`, which is not part of the capability id.

What is genuinely dynamic is *availability*, *policy outcome*, and *binding* — the projection. The architecture inherited "the catalog is undiscoverable" from "the projection is dynamic", and the gap below is what that cost.

### What goes missing today, ranked by how silent it is

**1. Authored, but no scenario reaches it.** The surface is a projection of what is mounted. A route no scenario visits, a drawer no scenario opens, a list no scenario fills — the components never register, so there is nothing to report. `--explain` does not help: `explainSurface()` iterates active registrations only. `check` does not help either — the baseline never contained the capability, so there is no drift. Scenario coverage is unmeasured and unmeasurable with the current commands.

**2. Registered, and silently rejected.** A duplicate `(type, instanceId)` yields a dead handle, first-wins; an `onRegister` guard rejection does the same. Both diagnostics go through `devError`, which prints only when `environment === "development"` — and the config shape [CLI §configuration](../20-cli.md#configuration) documents builds the app with `environment: "test"`. The rejected registration is absent from the snapshot **and** from the explanation. The registry does emit `component-rejected`, and the testing harness records it; the CLI's collector never reads the event stream. Copy-paste a component `type`, or render two instances without an `instanceId`, and a capability disappears with no output anywhere.

**3. Never authored at all.** A button with no `action` behind it. **Out of scope for this RFC and for any tool in this repository** — see [§what this RFC does not change](#what-this-rfc-does-not-change). Stated here so the coverage number is not read as something it is not.

Class 1 is the one a static inventory closes. Class 2 is a defect with a three-line fix, and C2's report is *wrong* without it — a duplicate-rejected component would appear as "unreached" with no explanation of why.

### The design principle this RFC is written to

> Better a missing check than a misleading check.

Every degradation below is therefore a **finding with a file and a line**, never a silent omission, and the inventory is labeled an upper bound rather than "the surface".

---

## Correction 1 — A static capability inventory (D35)

**Problem.** There is no artifact answering "what capabilities does this codebase author". Producing one currently requires mounting the app, which requires scenarios, which is the thing being checked.

**Decision.** Add a command that reads registration call sites without running anything:

```bash
agent-surface capabilities [--json]
```

No Vite dev server, no jsdom, no scenarios, no mount. It analyzes the TypeScript program and emits one entry per authored capability:

```ts
export interface AuthoredCapability {
  /** Canonical id, instance-independent: "view:devices.table.sort". */
  capabilityId: string;
  kind: "observation" | "action" | "procedure";
  /** Where a human can go and read it. */
  origin: { file: string; line: number };
  /** Literals recovered from the call site; absent when not statically known. */
  description?: string;
  effect?: "local-state" | "navigation";
  /**
   * How much of this call site the extractor understood.
   * `partial` — identity resolved, some metadata dynamic (the common case:
   *   a spread `instanceId`, a description built from a template).
   * `unresolved` — identity NOT resolved. Reported, never dropped.
   */
  resolution: "static" | "partial" | "unresolved";
  /** Present on `partial`/`unresolved`: what defeated the extractor. */
  note?: string;
}
```

**Failure discipline is the substance of this correction, not a detail.** A call site whose `type` is not a string literal, whose config object arrives spread from a variable the extractor cannot follow one hop, or whose capabilities are generated in a loop, is emitted with `resolution: "unresolved"`, its file and line, and a note naming the construct. `capabilities` **exits non-zero** when any entry is unresolved unless `--allow-unresolved` is passed. A partial understanding of the codebase that reports itself as complete is the exact failure this RFC exists to remove.

**The domain plane is not analyzed the same way.** `domain:` capabilities come from the oRPC router, which is already a static export — that is [OQ-1](13-open-questions.md#part-b--genuinely-open-questions)'s "build-time export of the registry inventory". Where a manifest is configured, the inventory includes it. Where one is not, the output says `domain: not analyzed` rather than reporting zero domain capabilities, which would read as "there are none".

**The inventory is an upper bound.** It includes capabilities in components no route renders any more — dead code. That is a different finding, not a false positive, and the output labels it: an entry present statically and absent from every scenario is reported as unreached (C2), and the developer decides whether the answer is "add a scenario" or "delete the component". The command's own summary line says `authored (upper bound)`.

**Proposed requirements.** `AS-COVER-001` (every statically resolvable registration call site in the analyzed program appears in the inventory), `AS-COVER-002` (an unresolvable call site is emitted with `resolution: "unresolved"` and an origin, never omitted), `AS-COVER-003` (`capabilities` exits non-zero when any entry is unresolved and `--allow-unresolved` was not passed).

---

## Correction 2 — `coverage`: authored minus reached (D36)

**Problem.** Even with C1, nothing joins the two halves. The question "which authored capability does no scenario reach" is a set difference no command computes.

**Decision.** Add:

```bash
agent-surface coverage
```

It builds the inventory (C1), mounts every scenario the config defines exactly as `check` does, and reports three sets:

| Bucket | Meaning | Verdict |
|---|---|---|
| `unreached` | authored, surfaced by no scenario | gap — the finding this command exists for |
| `undeclared` | present at runtime, no static origin | information: a dynamic registration, or an extractor gap |
| `unresolved` | C1 could not resolve the call site | gap, carried forward from C1 |

```text
14 authored (upper bound), 12 reached across 2 scenarios

unreached  (2)
  view:devices.export.toCsv        src/app/ExportMenu.tsx:44
       no scenario mounts devices.export
  view:billing.invoices.table.sort src/app/InvoicesTable.tsx:88
       no scenario mounts billing.invoices.table

surface coverage gap in 2 capabilities — add a scenario, or delete the component
```

**Reached means present in the explanation, not in the snapshot.** A capability a policy hid *was* reached: a scenario mounted it and the policy made a deliberate decision about it, which `inspect --explain` reports in full. Classifying policy-hidden capabilities as unreached would flood the report with the library's own correct behavior — the `anonymous` scenario alone would contribute eleven false gaps. The union is therefore taken over `explainSurface()` output across scenarios, joined on `capabilityId` (instance-independent by construction).

**Adoption has to ratchet, not gate.** A repository turning this on with 200 unreached capabilities cannot fix them in one pull request. `coverage` reads a committed `.agent-surface/coverage-allow.json` — capability ids with a reason string — and does not fail on entries listed there. Entries in the allowlist that are *no longer* unreached fail the command, so the list shrinks and cannot silently rot. Same idiom as the baselines `check` already commits.

Exit codes follow `AS-CLI-002`: `0` no gaps, `1` gaps, `2` usage error.

**Proposed requirements.** `AS-COVER-004` (a policy-hidden capability is classified reached), `AS-COVER-005` (exit codes mirror `AS-CLI-002`; a stale allowlist entry fails the command).

---

## Correction 3 — Stop asserting completeness the CLI cannot back (D37)

Independent of C1 and C2, cheap, and a prerequisite for C2 being correct. Four changes, all to what the commands *say*.

**3a. Report registration rejections.** The registry emits `component-rejected` with a `reason` of `"duplicate"` or `"guard"`; the testing harness records every event; the collector discards them. It should subscribe, carry them back as plain data alongside the snapshot and explanation, and render them:

```text
scenario admin  route /devices
9 callable, 2 visible-disabled, 1 registration rejected

rejected during mount  (1)
  ! devices.table (default)  duplicate — an earlier registration holds this key
```

Without this, C2 reports the shadowed capability as `unreached` and sends the developer looking for a missing scenario that would not have helped.

**3b. Say what the counts are relative to.** The header states the scenario, and states the scope when one is active — `scope` set in the config or `--scope` on the command line filters the snapshot *and* the explanation today, and nothing on screen says so. With an inventory available the header carries the denominator:

```text
scenario admin  route /devices  scope devices
9 callable, 2 visible-disabled, 0 hidden — 11 of 14 authored
```

**3c. Print the hidden count unconditionally.** It is already computed on every run and suppressed unless `--explain` was passed. A partially hidden surface currently looks complete. The *attribution* stays behind `--explain`; only the count moves.

**3d. `check` states its own relativity.** A green `check` reads as "the surface did not change". It means "the surface did not change in the scenarios someone wrote". The success line should say which scenarios were compared, and — when a coverage allowlist exists — that gaps are tracked elsewhere.

**Proposed requirements.** `AS-CLI-006` (registrations rejected during a mount appear in `inspect` output and in `--json`), `AS-CLI-007` (`inspect` and `check` headers name the scenarios and any active scope; counts are never printed without their qualifier).

---

## What this RFC does not change

This section is normative. C1 reads code; it does not expose anything.

**Directive §2.1 stands, unweakened.** No DOM scanning. No selector, coordinate, screenshot, or accessibility-tree identity. No "expose all controls" switch. *A capability still exists only through reviewed registration code* — the extractor reads exactly that code and creates nothing. It is the tool [Non-Goals §10](../11-non-goals.md) already contemplates: "If a future DX tool suggests annotations, it outputs code for humans to review, never runtime exposure." This one does not even suggest annotations; it counts the ones that exist.

**The inventory is never agent-facing, and reachability is the enforcement.** It lives in `@agent-surface/cli`, which no adapter imports and no application ships. It must not be re-exported from `@agent-surface/core`, mirroring `AS-EXPLAIN-004` — the rule that keeps `explainSurface()` off the package root adapters import. `AS-COVER-006` pins it.

**Scenarios are still required, for the projection.** This RFC does not remove scenario authoring and does not claim to. Availability, policy outcome and bound fields are functions of unbounded application state; no static analysis produces them, and a tool that pretended otherwise would be the misleading check this design principle rejects. What scenarios stop being is the gate on knowing *what exists*.

**Unchanged:** `snapshot()` — still synchronous, side-effect-free, never runs `read()` handlers. `invoke` in either mode. Every policy path. Every adapter. Every SI-tagged test. The `inspect`/`snapshot`/`check` commands keep their current semantics; C3 changes what they print, not what they compute.

**Still not detected by anything here:** a UI affordance that was never registered (motivation class 3). Nothing in this repository can find it, because there is nothing to find — no capability, no call site, no registration. Human review of the diff remains the only gate, and the coverage percentage must never be read as covering it.

---

## Adoption

C3 needs nothing from you — `inspect` and `check` say more the moment you upgrade. For the other two, in a repository that has never run them:

1. `agent-surface capabilities --allow-unresolved` — read the inventory, then fix or knowingly accept the unresolved call sites. Do this first: every number in step 3 is only as trustworthy as this step's output.
2. Drop `--allow-unresolved` once the list is empty, and keep it that way.
3. `agent-surface coverage`. Seed `.agent-surface/coverage-allow.json` from the first run with a real reason per entry, and commit it. Wire into CI as non-blocking.
4. Ratchet the allowlist down. Stale entries already fail, so it cannot grow back silently. Make it blocking when it is short enough to defend.

---

## Unresolved questions

Four of the five are settled by D35/D36. The fifth moved to Part B of [Decisions](13-open-questions.md#part-b--genuinely-open-questions) rather than being decided under time pressure.

1. **Which extractor?** ✅ **Resolved: the TypeScript program**, over the project's own `tsconfig`. It needs no app boot, resolves imports the way the project's type-checker does, and degrades predictably at the constructs C1 must report. The trade-off went exactly as expected — `tsconfig` include globs are broader than what a bundle reaches, which is why the output says `upper bound`. One thing the proposal did not anticipate: a workspace tsconfig aliases the *library's own source* into the program, where `registry.register(definition)` inside `useAgentComponent` reads as an unresolvable registration. Analysis is therefore rooted at the surface config's directory, and the count of files skipped for being outside it is printed rather than assumed.
2. **How far does the extractor follow a config object?** ✅ **Resolved: one hop** to a same-module `const`, then `unresolved`. Cheap, predictable, and the limit is visible in the output rather than in the implementation. Adjacent string-literal concatenation (`"long " + "description"`) resolves too — descriptions are the provider's cached prompt prefix (D28) and therefore long enough that authors wrap them, so calling that dynamic would have reported the codebase's most common formatting choice as a defect.
3. **Should `coverage` fold in the granular hooks?** ⏳ **Still open — now [OQ-13](13-open-questions.md#part-b--genuinely-open-questions).** Today every `useAgentAction`/`useAgentObservation` call site is reported `unresolved` with a note, which is the honest state and makes a codebase built on them fail `capabilities` until someone accepts the gap knowingly. Deciding between one extractor with two shapes and two extractors needs a real codebase using them; the example app uses `useAgentComponent` exclusively.
4. **Does `undeclared` deserve to fail the command?** ✅ **Resolved: report, do not fail** — tracked as [OQ-14](13-open-questions.md#part-b--genuinely-open-questions) for revisiting. Failing now would punish the legitimate dynamic registration to catch the extractor gap it is indistinguishable from. Implementation added a distinction the proposal missed: `domain:` ids reached at runtime are held apart from `undeclared` entirely, because the inventory never claimed that plane and reporting them as "no static origin" would file a stated boundary as a defect.
5. **Is the allowlist per-capability or per-component?** ✅ **Resolved: per-capability.** Per-component would be one line for a whole unmounted screen, and would hide a newly added capability inside an already-allowed component — the second failure mode is the one this RFC is about.

---

## Amendment — the command cut was wrong (D38)

> Added 0.11.0. Everything above stands: the analysis, the three corrections, the requirements, the failure discipline. What did not stand is the shape it shipped as.

This RFC recovered the catalog by adding two commands, `capabilities` and `coverage`. That split the surface along an **implementation seam** — *does this boot a TypeScript program? does it need jsdom?* — rather than along a question anybody has. Nobody wants "the catalog". They want to know what an agent can reach, and what it can't.

The tell is in this document's own [§adoption](#adoption): four steps, three commands, and an instruction to wire the last one into CI *separately* from the `check` that was already there. Two gates for one question.

The cost was not aesthetic. [20 §check](../20-cli.md#check) shipped this, and it is the most honest line the CLI has ever printed and the clearest statement of a hole:

```text
surface matches the baseline in admin, anonymous
that is a statement about these scenarios only; capabilities no scenario mounts
are `agent-surface coverage`'s question
```

A green tick, and underneath it the tool explaining which question it had declined to answer. In CI nobody reads the second line. A gate that names the check it is *not* performing is a gate with a hole in it, and this one was load-bearing: an entire unreached route passed.

**The correction.** One command per question — `init` / `inspect` / `snapshot` / `check`, which is [`orpc-agent`](https://orpc-agent.dev)'s surface — and a `--depth static|runtime|full` dial for how much of the answer to compute (`AS-CLI-008`). The verdict reaches all three mounting commands (`AS-COVER-007`); `check` alone fails on it. `AS-COVER-003`'s non-zero exit moved from `capabilities` to `check`: the discipline did not weaken, it concentrated in the one place CI reads.

**What the objection got right, and what it got wrong.** The note at the top of this document rejected putting the authored denominator in the `inspect` header because *"that would force a TypeScript program boot into every `inspect`"*. The cost is real and was never measured: on `examples/devices-app` it is **under a second** (`inspect` 2.1s, `capabilities` 2.5s, both 2.9s). That is an escape hatch, not a second command — and `--depth runtime` is the escape hatch, for the wide-tsconfig repository where it genuinely bites.

**Two defects the merge surfaced**, both of the class this RFC exists to remove:

- **A scope faked coverage gaps.** `coverage --scope devices` filtered the mount but not the catalog, so it reported both `app.navigation` capabilities as ones "no scenario mounts" — over two that every scenario mounts. The join now calls core's own `matchesScope` (re-exported from `@agent-surface/core/explain`, off the agent-facing root) rather than a second copy that would drift.
- **A partial run still produced a verdict.** A scenario that failed to mount reached nothing, so everything it would have surfaced counted as unreached. There is now no verdict at all in that case, and the failed scenarios are named instead.

**What this amendment does not change.** Every word of [§what this RFC does not change](#what-this-rfc-does-not-change). No runtime exposure path, no DOM scanning, no change to `snapshot()`, `invoke`, or any adapter, and `AS-COVER-006` still pins the catalog out of the package root adapters import.
