---
"@agent-surface/core": minor
---

Meta mode tells the model what it was refused and what its parameters mean (D31, `AS-META-006`).

**A refused scope is now marked.** `surface_discover` sets `scopeRejected: {prefixes}` on the requested prefixes the configured floor admitted nothing for:

```ts
// floor: ["devices"]
await surface_discover({ scope: ["billing"] });
// → { components: [], scopeRejected: { prefixes: ["billing"] }, … }
```

Previously that payload was indistinguishable from an empty surface — same shape, same empty arrays, no marker — and the two call for opposite next moves: ask again unscoped, versus stop asking. This is the rule `AS-META-003` already applies to budget truncation ("the marker travels in the payload the model reads"), applied to the other way a payload can come back smaller than requested. Partial refusals are reported too, so an admitted half returning results is no longer read as evidence the other half was empty.

The marker is **adapter-produced**: `snapshot()` never sets it, having no scope floor to intersect a request against. A prefix *broader* than the floor is not a refusal — it collapses to the floor's own prefix, which is D27's narrowing working as specified.

**The three meta verbs now describe their parameters.** `scope`, `capabilityId`, `instanceId`, `input`, `invocationId`, `confirmationId` and `surfaceVersion` carried no `description`, so a model had to infer from the names alone where each value comes from — while `surface_act`'s *tool* description carries normative guidance that `AS-META-004` depends on. `scope` is described rather than enumerated deliberately: valid tokens are live component types, and inlining them would make the tool block change on every mount, which is what `AS-META-005` and D28 exist to prevent. The description points at `components[].type` in a previous payload instead.

Additive in both cases — no host or adapter change is required, and tool-block size stays invariant in the catalog. One related fix: a disjoint scope combined with a `budget` no longer reports the budget's `truncated` count, which was computed against a surface the payload does not contain.

The `core` size budget moves 18 → 19 kB (measured 18.33 kB). The descriptions are the change, so this is the deliberate revision [02 §budgets](https://github.com/Wiseair-srl/agent-surface/blob/main/docs/02-architecture.md#bundle-and-performance-budgets-first-measured-baselines) asked for rather than drift. It is not temporary: the D28 default flip frees no bytes, and the compatibility branches only leave in 0.5.
