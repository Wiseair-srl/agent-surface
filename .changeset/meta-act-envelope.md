---
"@agent-surface/core": minor
---

`surface_act` validates its own envelope, and its `input` is typed (D32, `AS-META-007`, `AS-META-008`).

Two defects made `mode: "meta"` materially less reliable than `direct` for the same capabilities. Both were found running a live model against a meta-mode host; direct mode was never affected.

**`input` was the only untyped property in the meta tool block.** It is now `type: "object"`:

```json
{ "capabilityId": "view:devices.table.selectRows",
  "input": "{\"ids\": [\"d-to-03\"]}",
  "mode": "replace" }
```

That call — a JSON-encoded string where an object belongs, and `mode` hoisted out of `input` to sit beside the call-level modifiers — came back `INVALID_INPUT` from the *capability's* validator, saying the input does not match the capability's schema. It matched fine; the envelope was wrong, and nothing said so. An untyped property is the one position a provider's constrained decoder cannot constrain, so the model fell back to the convention its training data carries (`function_call.arguments`, a string) and sorted the rest of the arguments into the modifiers it could see. Typing costs nothing: direct mode already passes `act.inputSchema` through as the tool schema, and providers require that to be an object schema at the top level.

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
