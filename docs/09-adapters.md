# Adapters and tool projection

Adapters translate registry snapshots and invocations into a provider or browser protocol. They never become an execution authority.

Registry-backed adapters inherit the compiler authority already verified at registration and execute only through `registry.invoke`. Standalone provider tools must be compiled contracts admitted by `createAgentExposureGateway(authority)`.

## Adapter contract

```ts
interface AdapterHost {
  registry: AgentSurfaceRegistry;
  consumer: AgentConsumer;
  snapshotContext?: Omit<SnapshotContext, "consumer">;
}

interface AgentSurfaceAdapter {
  readonly name: string;
  start(host: AdapterHost): void | Promise<void>;
  stop(): void | Promise<void>;
}
```

An adapter must:

1. attach a stable, unique consumer identity to snapshots and invocations;
2. build exposure from `registry.snapshot`, never private registry state;
3. subscribe to `surface-changed` and refresh between agent turns;
4. pass `registrationId` and relevant `surfaceVersion` tokens back on invocation;
5. keep one `invocationId` for transport retries and never reuse it for a different request;
6. preserve error `code`, `retry`, and `details` in tool content;
7. keep an authoritative wire-name-to-capability-id map;
8. declare `topology: "embedded" | "remote"` or an explicit confirmation mode;
9. release subscriptions and pending waits on shutdown.

Consumer identity scopes policy and idempotency. Two adapter instances addressing the same registry need distinct, stable `consumer.id` values.

## Wire names

Provider tool names use this reversible encoding for ordinary ids:

```text
view:devices.table.selectRows  → view_devices__table__selectRows
domain:devices.disable        → domain_devices__disable
```

- `:` becomes `_` and `.` becomes `__`.
- repeated instances append `_at_<encoded-instanceId>`.
- encoded names are at most 64 characters.
- longer names use a deterministic hash suffix.
- collisions are detected across the emitted catalog and re-encoded with a longer hash.
- `decodeWireName` returns `undefined` for shortened, instance-qualified, or non-canonical names.

Always reverse provider names through the map produced for that catalog:

```ts
const capabilityId = toolset.wireNameMap().get(toolCall.name);
```

Do not fall back to string surgery: the canonical capability id is the audit and invocation identity.

## Embedded toolset

`createAgentToolset` is the provider-neutral adapter built into core:

```ts
const toolset = createAgentToolset(registry, {
  consumer: { id: "copilot-panel", kind: "embedded" },
  topology: "embedded",
});

const providerTools = toolset.tools().map((tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.inputSchema,
}));
```

```ts
interface AgentToolsetOptions {
  consumer: AgentConsumer;
  mode?: "direct" | "meta";
  topology?: "embedded" | "remote";
  confirmations?: "wait" | "two-phase";
  scope?: string[];
  budget?: { maxComponents?: number; maxBytes?: number };
}
```

`mode` defaults to `direct`, which produces one provider tool per capability. `budget` is valid only in `meta` mode; a direct catalog uses `scope` because silent truncation would hide tools without a model-visible marker.

### Rendering capability state

Each `AgentTool` separates stable definition text from live state:

```ts
interface AgentTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  state: {
    available: boolean;
    unavailableReason?: string;
    note?: string;
  };
  execute(
    input: JsonValue,
    call: { toolCallId?: string },
  ): Promise<AgentInvocationResult>;
}
```

Place `description` in the provider tool block. It contains stable plane, effect, confirmation, and authored text. Render `state` in a trailing context block that can change between turns without invalidating the stable prompt prefix:

```ts
function capabilityState(tools: AgentTool[]): string {
  const lines = tools.flatMap((tool) => {
    const parts = [
      tool.state.available
        ? undefined
        : `unavailable: ${tool.state.unavailableReason ?? "not right now"}`,
      tool.state.note,
    ].filter(Boolean);

    return parts.length ? [`- ${tool.name}: ${parts.join(" · ")}`] : [];
  });

  return lines.length ? `Current capability state:\n${lines.join("\n")}` : "";
}
```

Hidden capabilities have no tool. Visible but unavailable capabilities remain discoverable with their reason. `state.note` contains live oRPC binding context from `describe()`.

### Confirmation topology

`createAgentToolset` requires a topology or explicit confirmation mode.

| Topology | Default | Behavior |
|---|---|---|
| `embedded` | `wait` | Wait for host confirmation and retry internally; the model sees one final result |
| `remote` | `two-phase` | Return `CONFIRMATION_REQUIRED`; retry in a later turn with `confirmationId` |

A remote host may opt into `wait`, but it must keep the confirmation wait below its transport timeout and handle reconnects. `toolset.dispose()` aborts active waits. `registry.dispose()` expires pending confirmation records.

### Choosing a mode

| Surface shape | Recommended mode |
|---|---|
| Small or moderate catalog | `direct` |
| Moderate catalog with clear feature boundary | `direct` plus `scope` |
| Catalog too large for a provider tool block | `meta` (Experimental) |

Measure the target model and provider. The library does not automatically switch modes.

## Meta-tools mode

Meta mode is Experimental. It exposes three fixed tools and discovers capabilities lazily:

```text
surface_discover({ scope? })
surface_read({ capabilityId, instanceId? })
surface_act({ capabilityId, instanceId?, input,
              invocationId?, confirmationId?, surfaceVersion? })
```

It changes projection, not execution. All reads and actions use the same registry resolution, validation, policy, confirmation, concurrency, and staleness pipeline as direct tools.

Required behavior:

- ambiguous targets are left for the registry to classify; the adapter never invents a placeholder `registrationId`;
- `surface_act` accepts retry identity, confirmation evidence, and the discovery `surfaceVersion`;
- destructive and externally visible calls should echo `surfaceVersion` so movement under the plan fails closed;
- the three tool schemas are constant across surface mutations;
- verb envelopes reject unknown or missing properties as `INVALID_INPUT` before registry invocation;
- `surface_act.input` is an object; a JSON-encoded object string is repaired only when the resolved capability expects an object, with a development warning;
- a discovery budget reports `truncated: { droppedComponents }` in the model-visible payload;
- a refused scope reports `scopeRejected: { prefixes }`;
- agents observe change by calling `surface_discover` again and comparing `surfaceVersion`.

### Scope is discovery-only

Configured `scope` is a floor. A model-supplied meta `scope` may narrow it but cannot widen it. An empty array means no additional narrowing. A request entirely outside the floor returns an empty surface and identifies the refused prefixes.

Scope limits discovery, not authority: `registry.invoke` does not accept a scope token. Use policies and server enforcement for authorization. For a less-trusted peer, direct mode plus scope provides the stronger exposure boundary because hidden capabilities have no provider tool.

## WebMCP adapter

`@agent-surface/webmcp` is Experimental and maps the registry to `navigator.modelContext`:

```ts
const adapter = createWebMcpAdapter({
  snapshotContext: { scope: ["devices"] },
  exposeCapability: (descriptor) =>
    shouldExpose(descriptor) ? undefined : null,
});

await adapter.start({
  registry,
  consumer: { id: "browser-agent", kind: "webmcp" },
});
```

The curation hook may skip a capability or replace its description. It cannot replace execution.

Current mapping:

- one wire-named tool per available capability;
- refresh on `surface-changed`;
- execution through `registry.invoke`;
- two-phase confirmation;
- capability errors encoded in tool content;
- no-op start when `navigator.modelContext` is unavailable.

Unavailable capabilities are omitted because the current transport has no disabled-tool state. Use `snapshotContext.scope` to minimize exposure to the browser peer.

## Testing adapter

`@agent-surface/testing` consumes the same public registry seams with consumer kind `test`. See [Testing](08-testing.md).

## Custom adapter checklist

- [ ] Stable consumer id, unique per adapter instance.
- [ ] Snapshot scope appropriate for peer trust.
- [ ] Refresh on `surface-changed`.
- [ ] Resolution tokens preserved on invocation.
- [ ] Stable `invocationId` per attempt; conflicting reuse treated as a caller bug.
- [ ] Error fields preserved in tool content.
- [ ] Confirmation topology declared and host UI connected.
- [ ] Wire names reversed through the catalog map.
- [ ] Live capability state rendered outside stable descriptions.
- [ ] `stop()` fully unsubscribes and can run repeatedly.
- [ ] Behavior covered with `createTestSurface`.
