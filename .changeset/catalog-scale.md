---
"@agent-surface/core": minor
---

Catalog scale (docs/19, D28–D30) — raised by the first host driving the library at ~300 capabilities per route.

**Capability state is structured data, not description text (D28).** `AgentTool` gains `state: {available, unavailableReason?, note?}`, and `AgentProcedureDescriptor` gains `contextualNote`. Tool definitions sit at the front of a provider's cached prompt prefix, so folding `available` into `description` meant every user click invalidated the whole conversation behind it — the reporting host measured ~21k tokens per step re-billed at full rate. Both layers keep 0.1's exact output behind compatibility flags for one minor:

```ts
const toolset = createAgentToolset(registry, {
  consumer,
  topology: "embedded",
  descriptionIncludesState: false,   // stable tool block; render `state` yourself
});
createAgentSurfaceRegistry({ snapshotMergesContextualNote: false }); // for direct snapshot readers
```

`state` and `contextualNote` are populated either way, so you can migrate before the defaults move in 0.3. **If you opt in, render `state` somewhere the model reads it** — the `[currently unavailable: …]` signal is planning fuel, and it is gone from the description (docs/09 §rendering-capability-state has the trailing-state-block pattern).

**`mode: "meta"` is supported, no longer Experimental (D29).** It graduated on `AS-META-001…005`, which pin scope-as-a-floor, disjoint-scope emptiness, truncation marking, direct-mode confirmation/staleness parity, and constant tool-block size. Graduating it added one thing: `surface_act` now accepts `surfaceVersion`. Echo the value from `surface_discover` on destructive calls — a direct tool carries its catalog's version, so without an echoed token the staleness guard could never fire in meta mode. docs/09 §choosing-a-mode has the selection guide (direct under ~100 per route, scoped direct to ~200, meta beyond).

**Wire names are collision-checked and reversible only through the map (D30).** Names were already capped at 64 characters; what was missing is that nothing checked for collisions across an emitted catalog, and `decodeWireName` returned a *plausible wrong id* for shortened and `_at_<instance>` names — silently degrading the canonical id, which is the audit identity. Now:

```ts
const canonicalId = toolset.wireNameMap().get(toolCall.name);
```

`decodeWireName` returns `undefined` for anything it cannot re-encode byte-identically. **Breaking for hosts that reversed names by string surgery**, and shortened names change format (a `_0_` marker before the hash) so refusal is possible at all — this only affects capabilities whose encoding already exceeded 64 characters. `assignWireNames(entries)` is exported for adapters that build their own catalogs.

Also: `buildDirectTools` no longer re-filters the component array per component (O(n²) in the per-step projection path — ~90k comparisons at 300 mounted components); `stableDescriptionOf(descriptor)` recovers the note-free description in either merge mode.
