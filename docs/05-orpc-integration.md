# oRPC integration (`@agent-surface/orpc`)

The oRPC package makes an existing backend procedure contextually available through the frontend surface. It does not create a second implementation of that procedure.

```text
compiled procedure contract
  + manifest-backed oRPC reference
  + live UI binding
  → authorized registry registration
  → host oRPC client
  → authoritative server procedure
```

The compiled contract owns reviewable identity and governance. The bridge reference owns execution. Runtime configuration contributes only live UI context.

## When to use it

Use a procedure reference when an operation:

- has meaning without the current UI;
- executes on the server;
- benefits from frontend context such as selection, route, or confirmation UX.

Use a `view:` action instead when the behavior only changes the current interface.

A procedure reference can narrow exposure or pre-fill input. It cannot create backend authority, execute domain logic in the browser, or replace server authentication, authorization, validation, policy, rate limits, or audit.

## Declare the procedure contract

Declare the agent-facing procedure in code scanned by the compiler:

```ts
import {
  defineAgentProcedureContract,
  fromJsonSchema,
} from "@agent-surface/core";

export const devicesDisableContract = defineAgentProcedureContract({
  id: "domain:devices.disable",
  description: "Disable the given devices",
  input: fromJsonSchema<{ deviceIds: string[]; reason?: string }>({
    type: "object",
    properties: {
      deviceIds: { type: "array", items: { type: "string" }, minItems: 1 },
      reason: { type: "string" },
    },
    required: ["deviceIds"],
    additionalProperties: false,
  }),
  output: fromJsonSchema<{ disabled: number }>({
    type: "object",
    properties: { disabled: { type: "number" } },
    required: ["disabled"],
    additionalProperties: false,
  }),
  effect: "destructive",
  confirmation: "required",
});
```

Procedure ids use `domain:<dot.path>`. The dot path must match the bridge manifest and client path.

## Create the bridge

```ts
import { createOrpcAgentBridge } from "@agent-surface/orpc";

const bridge = createOrpcAgentBridge({
  client: orpcClient,
  manifest: agentManifest,
  callContext: (info) => ({
    agentInvocationId: info.invocationId,
    confirmation: info.confirmation,
  }),
});

registry.setProcedureExecutor(bridge.executor);
```

The client is the application's existing typed oRPC client and uses the user's normal authenticated transport.

### Manifest

The bridge manifest contract is Experimental. Keep its production source tied to the backend's agent exposure configuration.

```ts
interface OrpcAgentManifest {
  tools: Record<string, {
    description: string;
    inputSchema: JsonSchema;
    outputSchema?: JsonSchema;
    effect:
      | "server-query"
      | "server-mutation"
      | "external-side-effect"
      | "destructive";
    requiresApproval?: boolean;
  }>;
}
```

The manifest is the bridge's exposure ceiling. Only listed paths produce references in `bridge.refs`. The frontend may omit a reference, but it cannot add a path the manifest does not expose.

The manifest and compiled contract are independently checked at registration. Identity, description, schemas, effect, and confirmation posture must agree.

### Server error mapping

The bridge maps common authorization and approval errors to typed agent-surface results. Use `mapServerError` for application-specific server error shapes:

```ts
const bridge = createOrpcAgentBridge({
  client: orpcClient,
  manifest: agentManifest,
  mapServerError: (error) =>
    isForbidden(error)
      ? {
          code: "NOT_AUTHORIZED",
          message: "The server rejected this call as not authorized.",
          retry: "no",
          details: { origin: "server" },
        }
      : undefined,
});
```

Unmapped transport and procedure failures are sanitized as `EXECUTION_FAILED`; server error messages are not forwarded to the model.

## Bind the procedure in React

```tsx
import { useAgentProcedure } from "@agent-surface/orpc/react";

useAgentProcedure(
  devicesDisableContract,
  bridge.refs.devices.disable,
  {
    when: () => selectedIds.length > 0,
    unavailableReason: "Select at least one device first",
    bind: () => ({ deviceIds: selectedIds }),
    confirmation: "required",
    describe: () =>
      `Currently bound to ${selectedIds.length} selected device(s).`,
  },
);
```

```ts
function useAgentProcedure<
  TIn extends Record<string, JsonValue>,
  TOut extends JsonValue,
  TBound extends Partial<TIn> = Partial<TIn>,
>(
  contract: AgentProcedureContract<TIn, TOut>,
  ref: AgentProcedureRef<TIn, TOut>,
  config?: AgentProcedureBindingConfig<TIn, TBound>,
): void;
```

The hook registers in an effect and unregisters on unmount. `bind`, `when`, `unavailableReason`, and `describe` read current React state through live references.

### Exposure gating

The hook registers nothing when the reference is not created by `createOrpcAgentBridge`. A forged or stale reference cannot become an executable registration. The registry also verifies the compiled contract and reference semantics against its authority.

## Binding semantics

Let `bind()` return a partial input object.

1. Bound fields are removed from the agent-facing schema unless listed in `overridableFields`.
2. Bound fields are locked by default. Supplying one returns `INVALID_INPUT` with `details.lockedFields`.
3. An overridable field remains visible and optional; agent input wins when present, otherwise the bound value applies.
4. `bind()` runs during invocation against live UI state.
5. Agent input and bound values are merged, then validated against the complete procedure schema.
6. Input-aware policies and confirmation receive only this validated effective input.

Bound key shape must remain stable for the binding. Binding failures return `PRECONDITION_FAILED` with `details.reason: "binding-failed"` before confirmation or execution.

## Discovery shape

Procedure references appear in `snapshot.procedures`, separate from `snapshot.components`:

```ts
interface AgentProcedureDescriptor {
  procedureId: string;
  description: string;
  contextualNote?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  effect: AgentProcedureEffect;
  confirmation: "never" | "optional" | "required";
  available: boolean;
  unavailableReason?: string;
  boundFields: Array<{
    path: string;
    locked: boolean;
    source: "ui-state";
  }>;
  registrationId: string;
  context?: { type: string; instanceId: string };
}
```

`description` is stable compiler metadata. `contextualNote` contains live text returned by `describe()`. Adapters render them separately so stable tool definitions remain cacheable.

Two mounted components may reference the same procedure with different bindings. Calls must include the intended `registrationId`; omitting it when multiple references are live returns `AMBIGUOUS_INSTANCE`.

## Execution flow

1. Resolve the live procedure reference and staleness tokens.
2. Re-check availability and pre-input policies.
3. Build and validate effective input from agent input plus live bindings.
4. Run input-aware policy and confirmation over that effective input.
5. Call the installed bridge executor.
6. Forward through the application's authenticated oRPC client.
7. Re-check all authoritative controls on the server.

Frontend confirmation and server approval are independent. Passing browser confirmation evidence never grants server authority.

## Client and server responsibilities

| Check | Browser surface | Server |
|---|---|---|
| Procedure listed for agents | manifest and authority verification | authoritative exposure config |
| Authentication and authorization | advisory policy and UX | MUST enforce |
| Input validity | full-schema validation | MUST re-validate |
| UI-derived bindings | supplies current context | treats as untrusted input |
| Contextual availability | enforces | not applicable |
| Confirmation | single-use browser evidence | MAY require independent approval |
| Rate limits | bounded client controls | MUST enforce |
| Audit | frontend events | authoritative domain record |

## Supported topologies

- **Embedded loop:** the host projects registry tools directly in or next to the page.
- **Remote loop with per-turn frontend tools:** the host sends the current tool definitions to a server loop and routes calls back to the browser.

Both require a live page and registry. Synchronizing contextual frontend state to an autonomous server agent is not provided.

In either topology, expose a contextually governed procedure through exactly one model-facing path. A direct server tool and a frontend procedure reference for the same operation would bypass binding, staleness, or browser confirmation on one of the paths.
