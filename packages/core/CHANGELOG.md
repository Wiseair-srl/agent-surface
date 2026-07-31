# @agent-surface/core

## 0.6.0

### Minor Changes

- 774bec0: `surface_act` validates its own envelope, and its `input` is typed (D32, `AS-META-007`, `AS-META-008`).

  Two defects made `mode: "meta"` materially less reliable than `direct` for the same capabilities. Both were found running a live model against a meta-mode host; direct mode was never affected.

  **`input` was the only untyped property in the meta tool block.** It is now `type: "object"`:

  ```json
  {
    "capabilityId": "view:devices.table.selectRows",
    "input": "{\"ids\": [\"d-to-03\"]}",
    "mode": "replace"
  }
  ```

  That call — a JSON-encoded string where an object belongs, and `mode` hoisted out of `input` to sit beside the call-level modifiers — came back `INVALID_INPUT` from the _capability's_ validator, saying the input does not match the capability's schema. It matched fine; the envelope was wrong, and nothing said so. An untyped property is the one position a provider's constrained decoder cannot constrain, so the model fell back to the convention its training data carries (`function_call.arguments`, a string) and sorted the rest of the arguments into the modifiers it could see. Typing costs nothing: direct mode already passes `act.inputSchema` through as the tool schema, and providers require that to be an object schema at the top level.

  Typing binds providers that honor the schema while generating. For the ones that do not, `surface_act` parses an `input` that arrives as a string — **only** when the resolved target's own schema declares an object, and only when the string parses to a plain object, so a capability that genuinely declares a string input still receives it verbatim. The repair logs a development warning: a silent one is indistinguishable from the model getting it right, which hides the regression the shim absorbs.

  **The verbs' own schemas are now enforced.** `required` and `additionalProperties: false` were declared and never checked, so the envelope reached the pipeline as-is:

  ```ts
  await surface_act({});
  // before → EXECUTION_FAILED { reason: "handler-error", retry: "no" }  + a logged
  //          "invocation pipeline failure" (parseCapabilityId(undefined) threw)
  // after  → INVALID_INPUT { retry: "with-changes", issues: [{ path: "capabilityId", … }] }
  ```

  A caller error was being reported as an internal defect, carrying the one retry hint that tells a model to stop rather than fix its call. Each verb now checks the call against its own declared schema first and returns `INVALID_INPUT` naming the offending property — and for an unknown key, saying it probably belongs inside `input`, which turns the first defect's dead end into a one-retry recovery. Capability-input validation is unchanged and still the registry's: the two check different objects, and only the adapter can tell which one is wrong.

  `parseCapabilityId` also rejects a non-string id instead of throwing, so any other caller reaching it with one gets `CAPABILITY_NOT_FOUND` rather than a misclassified pipeline failure.

  No host change is required, and the meta tool block stays byte-stable across mounts (`AS-META-005`). Calls that were already well-formed behave identically; malformed ones that used to fail as `EXECUTION_FAILED` now fail as `INVALID_INPUT`, and some that used to fail now succeed. `AS-META-002` (a disjoint scope returns an empty surface) is untouched.

  The `core` size budget moves 18.5 → 19.5 kB (measured 18.86 kB). About 530 B is the envelope check shared by the three verbs plus the repair and its error strings; the model-facing descriptions were trimmed first, since those bytes are re-billed in every request carrying the tool block while the validator is paid once. This is the deliberate revision [02 §budgets](https://github.com/Wiseair-srl/agent-surface/blob/main/docs/02-architecture.md#bundle-and-performance-budgets-first-measured-baselines) asks for, not drift.

### Patch Changes

- 1dc09ad: `decodeWireName` no longer refuses a capability for having a segment named `at` or `0` (`AS-ID-004`, `AS-WIRE-007`).

  ```ts
  decodeWireName(encodeWireName("view:at.a.a"));
  // before → undefined
  // after  → "view:at.a.a"
  ```

  `view:at.a.a` encodes to `view_at__a__a`, which _contains_ `_at_` — the plane separator meeting a segment named `at`. The decoder screened for that substring to refuse `_at_<instanceId>` names, so every id with an `at` or `0` segment lost its own faithful encoding. A host consulting `toolset.wireNameMap()` was unaffected (it is authoritative, and always has been); a host falling back to `decodeWireName` got `undefined` for a name that reverses perfectly.

  The property suite found it on a random seed rather than a report — `{ seed: 654467906 }`, shrunk to `view:at.a.a` — which is what a randomly-seeded property test is for, and why this surfaced as a red build on `main`.

  **Refusal is now structural.** Three checks decide, and they still refuse every marker-bearing name — including hand-built ones and names an older release emitted:

  - every underscore run in the name is exactly two (one `.`);
  - no decoded segment is empty;
  - the id re-encodes byte-identically.

  **One real ambiguity was found underneath, and closed at the encoder.** `domain:` paths are opaque, so a path may carry a literal `_` — and then `domain:readState__0` and `domain:readState.0` both produce `domain_readState__0`. The substring screen was hiding some of those collisions by accident and missing others: `domain_readState__0` decoded to the wrong id in 0.5 and earlier. An id containing `_` is now **hashed instead of encoded faithfully**, which is the existing "not decodable — consult `wireNameMap()`" path rather than a new contract. Injectivity is now a property of what the encoder emits.

  Wire names change for `domain:` ids whose path contains `_` — they become hashed (`…_0_<hash>`) instead of a faithful encoding that was ambiguous. View ids cannot contain `_` (the grammar forbids it), so no view capability's name changes. `wireNameMap()` resolves both forms as before, and the 64-character budget (`AS-WIRE-004`) and cross-catalog uniqueness (`AS-WIRE-006`) are unchanged.

  Verified by a 300k-case fuzz over an alphabet built to break it (underscores, empty segments, marker lookalikes, per-instance and shortened forms): no wrong decode, no faithful encoding refused, no per-instance or shortened name decoded, every emitted name inside the alphabet and budget.

## 0.5.0

### Minor Changes

- f688924: **Breaking.** The D28 compatibility flags are removed rather than flipped. There is now one way to compose a tool description, and it is the split one.

  ```diff
    const toolset = createAgentToolset(registry, {
      consumer,
      topology: "embedded",
  -   descriptionIncludesState: false,   // no longer an option — this is the behavior
    });

  - createAgentSurfaceRegistry({ snapshotMergesContextualNote: false });
  + createAgentSurfaceRegistry({});
  ```

  Removed: `AgentToolsetOptions.descriptionIncludesState`, `RegistryOptions.snapshotMergesContextualNote`, and `stableDescriptionOf` — the last existed only to recover a note-free description across the two modes, and `description` now _is_ that string.

  **What changes if you set neither flag** (i.e. you were on the defaults): `AgentTool.description` no longer contains `[currently unavailable: …]` or the binding's contextual note, and `AgentProcedureDescriptor.description` no longer has the note folded in. Both signals are still there as data — `AgentTool.state {available, unavailableReason?, note?}` and `AgentProcedureDescriptor.contextualNote` — and **you must render them somewhere the model reads**, or it will plan steps it cannot take. [09 §rendering-capability-state](https://github.com/Wiseair-srl/agent-surface/blob/main/docs/09-adapters.md#rendering-capability-state) has the trailing-block pattern.

  **Why removal instead of the planned flip.** [19 §C4](https://github.com/Wiseair-srl/agent-surface/blob/main/docs/19-catalog-scale-rfc.md) scheduled the flags for one minor: introduce, flip, remove. D28 landed in 0.3 rather than the 0.2 the RFC was written against, and 0.4 shipped without the flip, so they had already run three minors on 0.1 behavior. Pre-1.0, two code paths for one composition were carrying a migration nobody had asked for. Flipping first would have bought a second breaking change one minor later for the same hosts.

  Also: `core` drops to **18.12 kB** and its size budget is retightened 19 → 18.5 kB.

## 0.4.1

### Patch Changes

- f897b7c: Documentation truth pass after 0.4.0. No behavior change in any package.

  0.4.0 shipped D31 alone, which left several published statements false:

  - **`descriptionIncludesState` and `snapshotMergesContextualNote` JSDoc** said the `true` default lasts "for one minor". It has now lasted three (0.2, 0.3, 0.4). This text ships in the `.d.ts`, so hosts read it in their editor — it now says "default through 0.4; flips in 0.5".
  - **[19 §C4](https://github.com/Wiseair-srl/agent-surface/blob/main/docs/19-catalog-scale-rfc.md)** scheduled the D28 flags as introduce-0.2 → flip-0.3 → remove-0.4. D28 landed in 0.3, and 0.4 shipped without the flip, so the live schedule is **flip in 0.5, remove in 0.6**. The accepted RFC answer is annotated rather than rewritten; the record of what was decided stays intact.
  - **[02 §budgets](https://github.com/Wiseair-srl/agent-surface/blob/main/docs/02-architecture.md#bundle-and-performance-budgets-first-measured-baselines)** claimed the 19 kB `core` budget returns at 0.5. Removal is 0.6, and flipping a default frees nothing regardless — both branches stay in the bundle while the flags exist.
  - **README and [12](https://github.com/Wiseair-srl/agent-surface/blob/main/docs/12-roadmap.md)** still described 0.4 as the unshipped "adoption and enforcement" milestone and pinned the packages at 0.3.0. v0.4 is recut as shipped; the enforcement work moves to v0.5.

  The D28 default flip is **not** in this release — it is a deliberate breaking change for any host that sets neither flag, and it needs a migration note rather than a patch bump.

## 0.4.0

### Minor Changes

- 3588342: Release all packages together at 0.4.0.

  The discovery-honesty changes (D31) land in `core` only, but the packages ship in lockstep while we are pre-1.0 — see `.changeset/README.md`. The `AgentSurfaceSnapshot` shape is what every adapter reads, so a version that identifies the whole surface contract is more useful than four packages trailing a minor behind it.

- 3588342: Meta mode tells the model what it was refused and what its parameters mean (D31, `AS-META-006`).

  **A refused scope is now marked.** `surface_discover` sets `scopeRejected: {prefixes}` on the requested prefixes the configured floor admitted nothing for:

  ```ts
  // floor: ["devices"]
  await surface_discover({ scope: ["billing"] });
  // → { components: [], scopeRejected: { prefixes: ["billing"] }, … }
  ```

  Previously that payload was indistinguishable from an empty surface — same shape, same empty arrays, no marker — and the two call for opposite next moves: ask again unscoped, versus stop asking. This is the rule `AS-META-003` already applies to budget truncation ("the marker travels in the payload the model reads"), applied to the other way a payload can come back smaller than requested. Partial refusals are reported too, so an admitted half returning results is no longer read as evidence the other half was empty.

  The marker is **adapter-produced**: `snapshot()` never sets it, having no scope floor to intersect a request against. A prefix _broader_ than the floor is not a refusal — it collapses to the floor's own prefix, which is D27's narrowing working as specified.

  **The three meta verbs now describe their parameters.** `scope`, `capabilityId`, `instanceId`, `input`, `invocationId`, `confirmationId` and `surfaceVersion` carried no `description`, so a model had to infer from the names alone where each value comes from — while `surface_act`'s _tool_ description carries normative guidance that `AS-META-004` depends on. `scope` is described rather than enumerated deliberately: valid tokens are live component types, and inlining them would make the tool block change on every mount, which is what `AS-META-005` and D28 exist to prevent. The description points at `components[].type` in a previous payload instead.

  Additive in both cases — no host or adapter change is required, and tool-block size stays invariant in the catalog. One related fix: a disjoint scope combined with a `budget` no longer reports the budget's `truncated` count, which was computed against a surface the payload does not contain.

  The `core` size budget moves 18 → 19 kB (measured 18.33 kB). The descriptions are the change, so this is the deliberate revision [02 §budgets](https://github.com/Wiseair-srl/agent-surface/blob/main/docs/02-architecture.md#bundle-and-performance-budgets-first-measured-baselines) asked for rather than drift. It is not temporary: the D28 default flip frees no bytes, and the compatibility branches only leave in 0.5.

## 0.3.0

### Minor Changes

- 7d8644e: Catalog scale (docs/19, D28–D30) — raised by the first host driving the library at ~300 capabilities per route.

  **Capability state is structured data, not description text (D28).** `AgentTool` gains `state: {available, unavailableReason?, note?}`, and `AgentProcedureDescriptor` gains `contextualNote`. Tool definitions sit at the front of a provider's cached prompt prefix, so folding `available` into `description` meant every user click invalidated the whole conversation behind it — the reporting host measured ~21k tokens per step re-billed at full rate. Both layers keep 0.1's exact output behind compatibility flags for one minor:

  ```ts
  const toolset = createAgentToolset(registry, {
    consumer,
    topology: "embedded",
    descriptionIncludesState: false, // stable tool block; render `state` yourself
  });
  createAgentSurfaceRegistry({ snapshotMergesContextualNote: false }); // for direct snapshot readers
  ```

  `state` and `contextualNote` are populated either way, so you can migrate before the defaults move in 0.3. **If you opt in, render `state` somewhere the model reads it** — the `[currently unavailable: …]` signal is planning fuel, and it is gone from the description (docs/09 §rendering-capability-state has the trailing-state-block pattern).

  **`mode: "meta"` is supported, no longer Experimental (D29).** It graduated on `AS-META-001…005`, which pin scope-as-a-floor, disjoint-scope emptiness, truncation marking, direct-mode confirmation/staleness parity, and constant tool-block size. Graduating it added one thing: `surface_act` now accepts `surfaceVersion`. Echo the value from `surface_discover` on destructive calls — a direct tool carries its catalog's version, so without an echoed token the staleness guard could never fire in meta mode. docs/09 §choosing-a-mode has the selection guide (direct under ~100 per route, scoped direct to ~200, meta beyond).

  **Wire names are collision-checked and reversible only through the map (D30).** Names were already capped at 64 characters; what was missing is that nothing checked for collisions across an emitted catalog, and `decodeWireName` returned a _plausible wrong id_ for shortened and `_at_<instance>` names — silently degrading the canonical id, which is the audit identity. Now:

  ```ts
  const canonicalId = toolset.wireNameMap().get(toolCall.name);
  ```

  `decodeWireName` returns `undefined` for anything it cannot re-encode byte-identically. **Breaking for hosts that reversed names by string surgery**, and shortened names change format (a `_0_` marker before the hash) so refusal is possible at all — this only affects capabilities whose encoding already exceeded 64 characters. `assignWireNames(entries)` is exported for adapters that build their own catalogs.

  Also: `buildDirectTools` no longer re-filters the component array per component (O(n²) in the per-step projection path — ~90k comparisons at 300 mounted components); `stableDescriptionOf(descriptor)` recovers the note-free description in either merge mode.

- 7d8644e: Release all packages together at 0.3.0.

  The catalog-scale corrections (D28–D30) land in `core` only, but the packages ship in lockstep while we are pre-1.0 — see `.changeset/README.md`. Adapters and hosts read the same `AgentTool` shape, so a version that identifies the whole surface contract is more useful than four packages trailing a patch behind it.

## 0.2.0

### Minor Changes

- df7663f: Implement configurable concurrency groups (D25, `AS-CONC-001` — the last requirement still marked `specified`).

  ```ts
  action({ /* … */ concurrency: { mode: "capability" } });
  ```

  - `AgentConcurrency = {mode:"instance"} | {mode:"capability"} | {mode:"key";key} | {mode:"parallel";max}`, each with an optional per-group `queueDepth`.
  - Default is unchanged: `{mode:"instance"}`, one FIFO queue per registration.
  - `parallel` requires an integer `max ≥ 1`; invalid groups throw `AgentSurfaceDefinitionError` at registration rather than degrading at runtime.
  - Groups are created on demand and dropped when idle, so the runtime holds one entry per currently contended group.
  - **Behavior change:** procedure references are now admitted through one group per procedure identity per referencing registration. Repeat calls of the same domain operation serialize client-side where they previously ran unbounded-parallel; a view action on the same component is never blocked by an in-flight domain call. Opt out with an explicit `concurrency` on the binding.

- 24a991b: Release all packages together at 0.2.0.

  `@agent-surface/orpc` and `@agent-surface/testing` now declare their `@agent-surface/react` peer as `>=0.1.0` rather than `workspace:^`. The caret range pinned the minor while React-side packages are still `0.x`, so every sibling minor read as a peer-range break — which is not what the constraint was ever meant to say. The packages are released in lockstep; the peer range now reflects that instead of forcing a major bump on packages whose own API did not change.

- e54f566: Meta-tools mode (Experimental) now honors the direct-mode contract.

  - `surface_read` no longer sends an empty `registrationId` when a target is not uniquely resolvable. An ambiguous read returned `STALE_CAPABILITY {retry:"after-refresh"}`, which sent agents into a refresh loop against an unchanged surface; it now returns `AMBIGUOUS_INSTANCE` with the instance list, matching `surface_act` and direct tools (`AS-ADAPTER-004`).
  - `surface_act` runs through the same invoke helper as direct tools, so staleness binding and the wait-mode confirmation retry no longer diverge.
  - **Behavior change:** the adapter-configured `scope` is now a floor (D27, `AS-ADAPTER-005`). A model-supplied `surface_discover({scope})` may only narrow it; `scope: []` is treated as "unspecified" rather than "everything", and a request outside the floor returns an empty surface. Previously the model's value replaced the configured one, so a scoped adapter could be widened back by asking. Callers relying on the old widening must raise the configured `scope` instead.
  - New `budget` option, `mode:"meta"` only — it truncates `surface_discover` and the `truncated` marker rides in the payload the model reads. Passing it with `mode:"direct"` now throws instead of silently dropping tools.
  - `toolset.subscribe` is documented as never firing in meta mode: the three-tool catalog is constant, and agents re-discover by comparing `surfaceVersion`.
