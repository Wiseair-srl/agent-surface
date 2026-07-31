---
"@agent-surface/core": patch
---

`decodeWireName` no longer refuses a capability for having a segment named `at` or `0` (`AS-ID-004`, `AS-WIRE-007`).

```ts
decodeWireName(encodeWireName("view:at.a.a"));
// before → undefined
// after  → "view:at.a.a"
```

`view:at.a.a` encodes to `view_at__a__a`, which *contains* `_at_` — the plane separator meeting a segment named `at`. The decoder screened for that substring to refuse `_at_<instanceId>` names, so every id with an `at` or `0` segment lost its own faithful encoding. A host consulting `toolset.wireNameMap()` was unaffected (it is authoritative, and always has been); a host falling back to `decodeWireName` got `undefined` for a name that reverses perfectly.

The property suite found it on a random seed rather than a report — `{ seed: 654467906 }`, shrunk to `view:at.a.a` — which is what a randomly-seeded property test is for, and why this surfaced as a red build on `main`.

**Refusal is now structural.** Three checks decide, and they still refuse every marker-bearing name — including hand-built ones and names an older release emitted:

- every underscore run in the name is exactly two (one `.`);
- no decoded segment is empty;
- the id re-encodes byte-identically.

**One real ambiguity was found underneath, and closed at the encoder.** `domain:` paths are opaque, so a path may carry a literal `_` — and then `domain:readState__0` and `domain:readState.0` both produce `domain_readState__0`. The substring screen was hiding some of those collisions by accident and missing others: `domain_readState__0` decoded to the wrong id in 0.5 and earlier. An id containing `_` is now **hashed instead of encoded faithfully**, which is the existing "not decodable — consult `wireNameMap()`" path rather than a new contract. Injectivity is now a property of what the encoder emits.

Wire names change for `domain:` ids whose path contains `_` — they become hashed (`…_0_<hash>`) instead of a faithful encoding that was ambiguous. View ids cannot contain `_` (the grammar forbids it), so no view capability's name changes. `wireNameMap()` resolves both forms as before, and the 64-character budget (`AS-WIRE-004`) and cross-catalog uniqueness (`AS-WIRE-006`) are unchanged.

Verified by a 300k-case fuzz over an alphabet built to break it (underscores, empty segments, marker lookalikes, per-instance and shortened forms): no wrong decode, no faithful encoding refused, no per-instance or shortened name decoded, every emitted name inside the alphabet and budget.
