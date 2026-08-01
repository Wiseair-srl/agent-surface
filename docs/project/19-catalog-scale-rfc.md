# 19 — Catalog Scale RFC (P1)

> [!IMPORTANT]
> **Status: Accepted; implemented in 0.3 (C1's compatibility flags removed in 0.5 — see C4).** Raised by the first host to drive `@agent-surface/core` at production catalog size (a DPAS dashboard targeting ~300 domain capabilities and 40+ mounted view capabilities per route). Three corrections and one cleanup. C1 is a breaking change to `AgentTool`, gated behind a compatibility flag for one minor. Accepted as decision records **D28–D30** in [Decisions](13-open-questions.md); requirements `AS-CACHE-001…004`, `AS-META-001…005`, `AS-WIRE-004…007` are in `spec/conformance.json`.
>
> Nothing here changes the surface's security model. Discovery shaping, wire-name encoding and description composition are all *presentation* concerns; `invoke` is untouched, and every SI-tagged test stands.
>
> **Deviations from this text, recorded during implementation** (directive §4.3 — the decision records outrank this document where they differ):
> 1. **C3's premise was partly stale.** `encodeWireNameForInstance` already capped names at 64 characters in 0.1 (`raw.slice(0,56) + "_" + hash7`). The real defects were the two it implies: no collision check across the emitted catalog, and a `decodeWireName` that returned a plausible **wrong** id for shortened *and* `_at_<instance>` names instead of refusing. Shortened names now carry a `_0_` marker so refusal is possible at all — which does change their format.
> 2. **C2 needed one API addition.** `surface_act` gained an optional `surfaceVersion`. Without it `AS-META-004` is unimplementable: a direct tool carries the version of the catalog it was built from, the meta verb re-resolves per call, so the destructive-effect staleness guard could never fire in meta mode. The graduation suite found this, which is what it was for.
> 3. **`AS-CACHE-002` is scoped to the provider-facing definition** (`name`, `description`, `inputSchema`) rather than the whole `AgentTool`: `state` is *supposed* to differ across an availability flip. Those three fields are what a host puts in the tool block, so that is what the requirement pins.
> 4. **The toolset flag alone buys the cache win.** `descriptionIncludesState: false` produces a stable description even on a registry still merging contextual notes, so migration step 2 is sufficient; `snapshotMergesContextualNote` is for direct readers of `snapshot.procedures`.

---

## Motivation

The library is correct at the scale its examples exercise (a devices page, ~14 capabilities). Two design choices that are invisible there become load-bearing at ~300, and one becomes a correctness bug.

A host driving a remote reasoning loop re-projects the surface on every step and ships the resulting tool list to a model provider. At that size the projection is no longer cheap, and — more importantly — **the tool block is the cache prefix**. Providers cache on a stable prompt prefix; tool definitions sit at the front. Any byte that changes between steps invalidates the whole conversation behind it.

`buildDirectTools` currently composes availability *into* the description string:

```ts
`${describePrefix("view", act.effect, act.confirmation, act.available, act.unavailableReason)} ${act.description}`
// → "[view · local-state] [currently unavailable: Select at least one device first] Update one or both filters…"
```

That is exactly the right *content* — "authority hides, state discloses" is a good rule and the reason string is planning fuel. It is in the wrong *place*. Because `available` flips as the user interacts, the description mutates mid-turn, so the tool block mutates, so the cache misses on every step. At 300 capabilities the host measured ~21k tokens per step re-billed at full rate, ~170k tokens per 8-step turn, entirely on tool definitions.

The fix is not to make descriptions stale. It is to stop making the host choose between honest state and a stable prefix — the library should hand back both, separately, and let the host place each where it belongs.

---

## Correction 1 — Capability state is structured data, not description text (D28)

**Problem.** `AgentTool.description` is a single pre-composed string carrying two things with different lifetimes: a stable part (plane, effect, confirmation, the authored description) and a volatile part (`available`, `unavailableReason`, and any live text a contextual binding's `describe()` injected). A host cannot separate them again without parsing the prefix it did not write, which is brittle and loses the binding note entirely.

The consequence is that no host consuming `mode: "direct"` can achieve prompt-prefix caching, regardless of what it does on its side. The library forecloses it.

**This spans two layers, not one.** The volatile text is folded in twice, and both have to change:

```ts
// snapshot.ts — contextual describe() merged into the descriptor itself
let description = proc.baseDescription;
const contextual = describe();
if (contextual) description = `${description} ${contextual}`.trim();

// toolset.ts — availability merged on top when building the tool
`${describePrefix("view", act.effect, act.confirmation, act.available, act.unavailableReason)} ${act.description}`
```

So `AgentProcedureDescriptor.description` is already lossy at the snapshot layer, before the toolset sees it. C1 therefore touches the **snapshot contract**, which is public API with its own conformance requirements — this is a minor-version change, not a toolset-local tweak.

**Decision, part 1 — the snapshot keeps the two apart.** `AgentProcedureDescriptor` gains a separate field and stops merging:

```ts
export interface AgentProcedureDescriptor {
  /** Stable: the manifest description. No contextual text. */
  description: string;
  /** Volatile: this snapshot's contextual describe() output, if any. */
  contextualNote?: string;
  // …unchanged
}
```

**Decision, part 2 — `AgentTool` carries state as structured data alongside a stable description.**

```ts
export interface AgentTool {
  name: string;
  /**
   * Stable: plane + effect + confirmation prefix, then the authored
   * description. Contains NO live state — safe to place in a provider tool
   * block and expect prefix caching across steps.
   */
  description: string;
  inputSchema: JsonSchema;
  /**
   * Volatile: re-derived on every snapshot. Hosts render this outside the
   * tool block (e.g. a trailing system message) so availability stays honest
   * without invalidating the cached prefix.
   */
  state: {
    available: boolean;
    unavailableReason?: string;
    /** Live text contributed by a contextual binding's describe(). */
    note?: string;
  };
  execute(input: JsonValue, call: { toolCallId?: string }): Promise<AgentInvocationResult>;
}
```

`describePrefix` keeps composing plane, effect and confirmation — those are stable properties of the capability, not of the moment. It stops composing `[currently unavailable: …]`. `state.note` is populated from the descriptor's `contextualNote`.

**Compatibility.** Two flags, because the two layers have different consumers:

- `AgentToolsetOptions.descriptionIncludesState?: boolean`, default `true` — today's exact tool output — for one minor. `false` opts into the split.
- `createAgentSurfaceRegistry({ snapshotMergesContextualNote })`, same default and lifecycle, for direct readers of `snapshot.procedures`.

`state` and `contextualNote` are populated in both modes, so a host migrates before either default moves. Defaults flip together in the following minor; flags retained one more cycle before removal.

**Consequences.** Hosts that render nothing new get a tool block whose churn drops to code changes and mount-set changes. The `[currently unavailable]` signal must be re-rendered by the host or it is lost from the model's view — a real migration burden and the reason for the flags. Documented in [Adapters](../09-adapters.md) with a worked example of the trailing-state-block pattern, and in [Core API](../03-core-api.md) for the snapshot side.

**Proposed requirements.** `AS-CACHE-001` (state is absent from `description` when the flag is off), `AS-CACHE-002` (`tools()` output is byte-identical across snapshots that differ only in availability), `AS-CACHE-003` (`state.note` carries the binding `describe()` contribution), `AS-CACHE-004` (`AgentProcedureDescriptor.description` is free of contextual text when `snapshotMergesContextualNote: false`).

---

## Correction 2 — Graduate `mode: "meta"` (D29)

**Problem.** `mode: "meta"` is implemented — `surface_discover`, `surface_read`, `surface_act`, with `budget` and the `truncated` marker wired through — and marked `[Experimental]` in [Adapters](../09-adapters.md) and in `AgentToolsetOptions`. It is the only answer the library offers for a catalog that cannot be made to fit a provider tool block, and for the accuracy problem that is independent of token cost: model tool-selection degrades on flat lists of hundreds of tools regardless of context window.

An experimental marker means no host will adopt it for production, so the library's own scaling answer is unreachable in the situation it was designed for.

**Decision.** Graduate `meta` to supported, contingent on a conformance suite that pins its distinguishing behaviors:

1. A model-supplied `scope` narrows the configured floor and never widens it (already D27; needs a test citing the ID).
2. A disjoint requested scope yields empty, never the floor.
3. `budget` truncation sets `truncated` in the payload the model reads, and `surface_discover` output remains valid against the snapshot schema when truncated.
4. `surface_act` enforces the same confirmation and staleness semantics as the equivalent direct tool — asserted by running the existing direct-mode confirmation and `STALE_CAPABILITY` cases through the meta path.
5. Tool-block size is invariant in the number of registered capabilities.

Keep the `budget`-rejected-in-`direct`-mode guard exactly as it is. Throwing rather than silently dropping tools is the correct call and this RFC does not touch it.

**Consequences.** Meta mode becomes a supported topology with a documented cost — one extra round trip before the first act — and the docs gain a selection guide: direct under ~100 capabilities per route, scoped direct to ~200, meta beyond.

**Proposed requirements.** `AS-META-001`…`AS-META-005`, one per behavior above.

> [!NOTE]
> **Reversed in 0.7.** This correction shipped as written — `meta` was Supported from 0.2 through 0.6 — and was then returned to **Experimental** (D29). The five requirements above pin what the mode does *differently* from `direct`; none of them reaches the verbs' own envelope, and that is where 0.6 found two defects against a live model (D32, `AS-META-007/008`). The problem statement below still holds and is not what changed: an Experimental marker does discourage production adoption of the library's only large-catalog answer. What changed is the evidence — a suite covering the distinguishing behaviors was read here as proof the contract had settled, and it was not that.

---

## Correction 3 — Wire names must fit the provider budget (D30)

**Problem.** Provider tool names are limited to 64 characters, which [Adapters](../09-adapters.md) documents. `encodeWireNameForInstance` does not enforce it. `view_` plus four `__`-joined segments reaches ~50 characters, and the multi-instance `_at_<instanceId>` suffix pushes it over. Deep feature hierarchies (`billing.invoices.table.filters.set`) are exactly what a 300-capability application has.

Two failure modes, both silent from the library's side. The provider rejects the whole request; or the host's reverse mapping fails and — depending on how defensively it is written — the canonical id degrades to the wire name, taking the audit identity with it.

**Decision.** `encodeWireNameForInstance` never emits a name longer than 64 characters. When the natural encoding would exceed it, the trailing segment is replaced by a deterministic short hash of the full canonical id, collision-checked within the emitted catalog:

```
view_billing__invoices__table__filters__set_at_<instance>   (73 chars)
→ view_billing__invoices__table__f_0_h7k2m9            (≤ 64, stable, collision-checked)
```

*(Implemented with a `_0_` marker before the hash, not a bare `_`: without a marker there is no way for `decodeWireName` to tell a shortened name from a faithful one, and the requirement below that it return `undefined` for shortened names would be unimplementable. See the deviations note at the top — the 64-char cap itself was already enforced in 0.1.)*

The toolset exposes the mapping so a host can recover the canonical id without parsing:

```ts
export interface AgentToolset {
  tools(): AgentTool[];
  /** wireName → canonical id. Authoritative; shortened names are not decodable by string surgery. */
  wireNameMap(): ReadonlyMap<string, string>;
  subscribe(listener: (tools: AgentTool[]) => void): Unsubscribe;
  dispose(): void;
}
```

`decodeWireName` continues to work for names that were not shortened and returns `undefined` for those that were — hosts must consult `wireNameMap()`, and the doc says so plainly. Emitting a name that a provider rejects, or one that silently loses its canonical identity, is not acceptable behavior for a library whose central claim is a stable audit identity.

**Compatibility.** Changes emitted names only for capabilities whose encoding currently exceeds 64 characters — precisely the names that do not work today. Treat as a fix; note it in the changeset.

**Proposed requirements.** `AS-WIRE-004` (≤ 64 always), `AS-WIRE-005` (deterministic across snapshots), `AS-WIRE-006` (no collisions within one emitted catalog), `AS-WIRE-007` (`wireNameMap()` round-trips every emitted name).

---

## Cleanup — O(n²) instance detection

Not a correction; no decision record needed.

`buildDirectTools` determines multi-instance status per component by re-filtering the whole component array:

```ts
const multiInstance = snapshot.components.filter((c) => c.type === component.type).length > 1;
```

That is O(n²) in mounted components, inside the per-step projection path. At 40 mounted components it is negligible; at 300 it is ~90k comparisons on the browser main thread per step. Replace with a single pre-pass building a `Map<string, number>` of type counts, mirroring what the procedure loop below it already does with `procedureCounts`.

---

## What this RFC does not change

- `invoke` in either mode. Scope remains discovery-only (D27); availability, confirmation, staleness and policy evaluation are untouched.
- The `budget`-in-`direct`-mode guard (C2).
- Any SI-tagged test.
- The snapshot contract: still synchronous, side-effect-free, never runs `read()` handlers.
- `registry.snapshot({ scope })`, which already does what a scaling host needs. The DPAS host's failure to pass it is a host bug, not a library gap, and is tracked in that repo.

## Migration for hosts

1. Adopt `wireNameMap()` in place of any local wire-name reversal. Unblocks C3 and removes a class of silent audit-identity loss. *(Independent; do first.)*
2. Render `AgentTool.state` into a trailing block outside the tool definitions. *(C1. The `descriptionIncludesState` flag this step once named was removed in 0.5 — the split is now the only composition, so there is nothing to opt into and rendering `state` is the whole migration.)*
3. Consider `mode: "meta"` if a scoped direct catalog still exceeds the provider's practical tool count. *(C2. Experimental again since 0.7 — opt in with a pinned version, per [Adapters §meta-tools-mode](../09-adapters.md#meta-tools-mode).)*

## Unresolved questions — as resolved on acceptance

1. **C1: is `state.note` one string or a structured record?** *One string,* as the RFC body specified. It is authored prose from `describe()`, and the structured version already exists: `snapshot.procedures[].boundFields` carries paths and locked flags. Two shapes for one fact would drift. Revisit if a host demonstrates a rendering it cannot build from `boundFields`.
2. **C3: short-hash length, fixed or collision-check-and-extend?** *Collision-check-and-extend,* per the RFC body. 7 base36 chars at level 0, escalating to 9/11/13 for the entries that actually collide, with a rank tie-break that terminates by construction. A fixed longer hash would tax every name to fix a case that arises in a few; uniqueness is a property of the catalog, so it is checked there. Pinned by a real level-0 collision in `wire-names.test.ts` — found by search over the shipped hash, so the escalation path is exercised rather than assumed.
3. **C2: does graduating `meta` freeze the `surface_discover` payload?** *It is the snapshot contract, versioned with it.* `surface_discover` returns `AgentSurfaceSnapshot` verbatim; no separate payload shape exists to version separately, and inventing one would be a second source of truth for the catalog. `AS-META-003` pins that a truncated payload is still a valid snapshot. `budget` itself stays Experimental (D6/OQ-4). *(Still true after the 0.7 reversal — the answer was about the discover payload, which never was the unsettled part. The envelope of the three verbs was, and D32 is where that surfaced.)*
4. **When does `descriptionIncludesState` flip?** *One minor after the deprecation warning,* as the RFC body says: the plan was 0.2 ships both flags defaulting to 0.1 behavior, 0.3 flips both defaults together, 0.4 removes them. A host that sets nothing gets one release with a warning before its model's view changes.

   > [!NOTE]
   > **Resolved differently.** The schedule slipped twice — D28 landed in **0.3**, not the 0.2 this RFC was written against, and **0.4** shipped D31 alone — which would have made three minors of default-to-0.1 behavior against the one this answer promised. Rather than flip and then remove, **0.5 removed both flags outright**: the library is pre-1.0 and the deferred migration was buying nothing. The split is the only composition, and `stableDescriptionOf` was removed with them.
5. **Could the flags be skipped entirely?** *No.* The package is public on npm and the repo's own hosts are not the only callers, so the availability text may be load-bearing for someone this repo cannot see. The migration burden is real — a host that adopts the split and renders nothing loses `[currently unavailable]` from the model's view — and that is exactly what a compatibility default is for. Cost is one minor of duplicated composition, all of it behind one branch.
