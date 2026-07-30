---
"@agent-surface/core": minor
---

Meta-tools mode (Experimental) now honors the direct-mode contract.

- `surface_read` no longer sends an empty `registrationId` when a target is not uniquely resolvable. An ambiguous read returned `STALE_CAPABILITY {retry:"after-refresh"}`, which sent agents into a refresh loop against an unchanged surface; it now returns `AMBIGUOUS_INSTANCE` with the instance list, matching `surface_act` and direct tools (`AS-ADAPTER-004`).
- `surface_act` runs through the same invoke helper as direct tools, so staleness binding and the wait-mode confirmation retry no longer diverge.
- **Behavior change:** the adapter-configured `scope` is now a floor (D27, `AS-ADAPTER-005`). A model-supplied `surface_discover({scope})` may only narrow it; `scope: []` is treated as "unspecified" rather than "everything", and a request outside the floor returns an empty surface. Previously the model's value replaced the configured one, so a scoped adapter could be widened back by asking. Callers relying on the old widening must raise the configured `scope` instead.
- New `budget` option, `mode:"meta"` only — it truncates `surface_discover` and the `truncated` marker rides in the payload the model reads. Passing it with `mode:"direct"` now throws instead of silently dropping tools.
- `toolset.subscribe` is documented as never firing in meta mode: the three-tool catalog is constant, and agents re-discover by comparing `surfaceVersion`.
