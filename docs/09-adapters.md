# 09 — Adapters and Interoperability

> [!NOTE]
> **Status:** adapter contract and embedded toolset **Draft**; meta-tools mode and WebMCP adapter **Experimental**; MCP bridge and Playwright fallback **Future**. The core model never depends on any protocol here — adapters are replaceable skins over the registry, and the library must stay valuable if any given protocol (WebMCP included) changes or fades.

## Adapter contract

```ts
export interface AgentSurfaceAdapter {
  readonly name: string;
  start(host: AdapterHost): void | Promise<void>;
  stop(): void | Promise<void>;
}

export interface AdapterHost {
  registry: AgentSurfaceRegistry;
  consumer: AgentConsumer;               // identity this adapter acts as
  /** Adapter-scoped snapshot defaults (scope, budget). */
  snapshotContext?: Omit<SnapshotContext, "consumer">;
}
```

Normative duties of every adapter:

1. MUST attach a stable `consumer` to every snapshot and invocation (policies are per-consumer). The consumer's `(kind, id)` pair is the invocation-identity namespace (D22): when more than one adapter/consumer instance can address the same registry, each MUST use a distinct, stable `consumer.id` (e.g. suffix an adapter-instance nonce) — provider tool-call ids are only unique *within* a consumer.
2. MUST subscribe to `surface-changed` and refresh whatever catalog it exported; MUST NOT cache descriptors across versions.
3. MUST pass through `registrationId` (and SHOULD pass `surfaceVersion`) from the catalog entry it is executing, enabling staleness enforcement.
4. MUST supply a stable `invocationId` per external call attempt (e.g. the provider's tool-call id) so transport retries dedupe. Retries of the *same* attempt reuse the id verbatim; a **new** request MUST get a new id — reusing an id for a different request fails `INVOCATION_CONFLICT` ([Errors](07-errors.md#invocation_conflict)) and MUST NOT be retried by stripping or rotating identity tokens.
5. MUST map results per [Errors §adapter mapping](07-errors.md#adapter-mapping-guidance), preserving `code`/`retry`/`details`.
6. MUST NOT invent capabilities, merge planes into one namespace without labeling, or strip effect/confirmation metadata from descriptions.
7. SHOULD translate ids to wire-safe names via the codec below, keeping the id↔name map per catalog version.
8. MUST declare its confirmation topology (below): `topology: "embedded" | "remote"` or an explicit `confirmations` mode. There is no global default (D26).

## Wire names

Provider tool-name alphabets are restricted (typically `[a-zA-Z0-9_-]`, length-capped at **64 characters**). Canonical codec:

```text
encode(id): ":" → "_"    "." → "__"          e.g. view:devices.table.selectRows
                                              ⇒ view_devices__table__selectRows
decode(name): first "_" not part of "__" splits the plane; "__" → "."
```

The codec is reversible because the id grammar forbids `_` ([Concepts §grammar](01-concepts.md#canonical-id-grammar-draft)) — everywhere except `domain:` paths, which are opaque and may carry one. **An id containing `_` is therefore hashed rather than encoded faithfully**, since `domain:readState__0` and `domain:readState.0` would otherwise share a name no decoder can split. Injectivity is a property of what the encoder emits, not a hope about what ids look like.

- **The 64-character budget is enforced, never advisory** (`AS-WIRE-004`, D30). A name that would exceed it is *shortened* to the kept prefix + the marker `_0_` + a hash of the full id (54 + 3 + 7).
  *Why it is not a corner case:* a deep feature hierarchy plus the `_at_<instanceId>` suffix reaches it routinely — `view:billing.invoices.table.filters.setSelectedRange` in two instances is 73 characters unshortened.

- **Shortening is deterministic per id** (`AS-WIRE-005`) and **collision-checked across the emitted catalog** (`AS-WIRE-006`): two entries that would land on the same name are both re-encoded at a longer hash, so the outcome depends on the set of capabilities, not on the order they were projected in. `assignWireNames(entries)` in core does this for any adapter building a catalog.

- **`decodeWireName` returns `undefined` for anything it cannot reverse** — shortened names, `_at_<instanceId>` names, and anything that does not re-encode byte-identically. Reverse names through `toolset.wireNameMap()` instead (`AS-WIRE-007`); it is authoritative, and adapter duty 7 already requires keeping it.
  *Why refusal beats a guess:* the canonical id **is** the audit identity, so a host that degrades it to a plausible-but-wrong id loses the one thing this library guarantees about a call. And refusal is decided by what a name *is* — three structural checks, the last being that the id re-encodes byte-identically — never by a marker substring it contains: `view:at.a.a` legitimately encodes to `view_at__a__a`, and substring screening cost every id with an `at` or `0` segment its faithful encoding (`AS-ID-004`).

```ts
const canonicalId = toolset.wireNameMap().get(toolCall.name);
// NOT: decodeWireName(toolCall.name) ?? toolCall.name  ← silent identity loss
```

## Embedded toolset adapter (Draft)

The primary consumer: an agent loop running in the host app, with any provider. Core's `createAgentToolset` ([Core API §toolset](03-core-api.md#toolset)) does the projection; the host maps `AgentTool[]` to its SDK. This is deliberately framework-neutral — the same catalog plugs into Vercel AI SDK `streamText`, a Mastra agent (forwarded per turn as client tools), LangGraph, or assistant-ui's model context. There is no `@agent-surface/mastra` package because none is needed; the wiring for that stack is sketched in [Mastra + assistant-ui](16-mastra-assistant-ui.md) (hand-written snippets — the executable example is the embedded loop in `examples/devices-app`). The description template prepends plane/effect so models can tell reads from view changes from authoritative mutations:

```text
[view · local-state] Replace, extend or reduce the row selection …
[domain · destructive · requires confirmation] Disable the given devices …
```

Example wiring (Anthropic SDK-style, illustrative host code — not part of the library):

```ts
const toolset = createAgentToolset(registry, {
  consumer: { id: "copilot-panel", kind: "embedded" },
  topology: "embedded",              // ⇒ confirmations default to "wait" (D26)
});

function providerTools() {
  return toolset.tools().map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}
// on tool_use block:
const result = await tool.execute(block.input, { toolCallId: block.id });
// feed JSON.stringify(result.status === "ok" ? result.output : result.error) back
// re-send providerTools() whenever toolset.subscribe fires between turns
```

Mid-conversation surface changes: tools are re-listed **between turns**; a call targeting a removed capability inside a turn fails with the appropriate staleness error, which the model handles via `retry: "after-refresh"` — by design there is no attempt to mutate a provider's tool list mid-turn.

### Rendering capability state

Tool definitions sit at the **front of the provider's cached prompt prefix**. Any byte that changes between steps invalidates the whole conversation behind it, and availability changes every time the user clicks. So the toolset hands back the two halves separately (D28) and the host places each where it belongs:

```ts
const toolset = createAgentToolset(registry, {
  consumer: { id: "copilot-panel", kind: "embedded" },
  topology: "embedded",
});

// Front of the prompt — stable across steps, cacheable.
const providerTools = toolset.tools().map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.inputSchema,
}));

// End of the prompt — re-rendered every step, cheap to invalidate.
function stateBlock(): string {
  const lines = toolset.tools().flatMap((t) => {
    const bits = [
      t.state.available ? undefined : `unavailable: ${t.state.unavailableReason ?? "not right now"}`,
      t.state.note,
    ].filter(Boolean);
    return bits.length > 0 ? [`- ${t.name}: ${bits.join(" · ")}`] : [];
  });
  return lines.length > 0 ? `Current capability state:\n${lines.join("\n")}` : "";
}
```

Normative points:

- **The `[currently unavailable: …]` signal is not optional, it moved.** A host that renders nothing loses it from the model's view, and the model starts planning steps it cannot take. There is no opt-out: the split is the only composition since 0.5.
- "Authority hides, state discloses" (D12) is unchanged. Hidden capabilities still have no tool; disclosed-but-unavailable ones still carry their reason — in `state`, where a host can put it in a block it is willing to invalidate.
- `subscribe` fires on state-only changes too, so the trailing block can be re-rendered even when the definitions are byte-identical.
- `state.note` carries a procedure reference's contextual `describe()` output ([oRPC integration §snapshot-descriptor](05-orpc-integration.md#snapshot-descriptor)). It is one string; a host that wants structure should read `snapshot.procedures[].boundFields` directly.

### Confirmation topology

`createAgentToolset` requires a declared topology (or an explicit `confirmations` mode); omitting both throws. The mapping and its consequences (D26, [Spec Corrections RFC §correction 6](project/18-spec-corrections-rfc.md#correction-6--confirmation-mode-is-declared-by-topology-never-defaulted-globally-d26)):

| Topology | Default mode | Why |
|---|---|---|
| `embedded` (loop in/next to the page) | `wait` | The run can block on the user cheaply; the model sees one call → one result. |
| `remote` (server-side loop, per-turn frontend tools) | `two-phase` | Wait-mode would hold the provider run open across a human approval: transport/stream timeouts, broken reconnects, billed idle time. The model receives `CONFIRMATION_REQUIRED` and retries next turn with the `confirmationId`. |

A remote adapter MAY opt into `wait` explicitly — it then owns its transport-timeout story and MUST bound the wait below the transport's own timeout. Recovery after reconnect: re-snapshot; a confirmation approved while disconnected is retried by id within its TTL, an expired one restarts the cycle (`CONFIRMATION_INVALID {reason:"expired"}` → fresh `CONFIRMATION_REQUIRED`). Shutdown is deterministic: `toolset.dispose()` aborts in-flight wait-mode waits (the pending `CONFIRMATION_REQUIRED` result is returned as-is); `registry.dispose()` expires all pending records.

### Choosing a mode

| Catalog per route | Mode | Why |
|---|---|---|
| up to ~100 capabilities | `direct` | Provider-native input typing and one tool per capability; the model picks accurately and the tool block is affordable. |
| ~100–200 | `direct` with `scope` | Bound the catalog to the route's own component types. A tool that does not exist cannot be mis-selected, and the floor is a boundary rather than a filter. |
| beyond ~200 | `meta` (**Experimental**) | Tool-block size stops tracking the surface (`AS-META-005`), and tool-selection accuracy stops degrading on a flat list of hundreds. Costs one round trip before the first act. |

These are starting points from catalog-size measurements, not thresholds the library enforces; a host that measures its own model's behavior should trust that instead. Automatic switching remains deliberately unspecified (OQ-9).

`meta` is **Experimental**: opt-in, and its envelope may change in any release (D29, below). The threshold above is where it becomes the least-bad option, not a promise that its shape is settled — a host adopting it should pin the version and re-read this section on upgrade.

### Meta-tools mode

For large surfaces, three fixed tools replace the per-capability catalog, trading provider-native input typing for a constant tool count and lazy discovery:

```text
surface_discover({ scope? })                → snapshot catalog (JSON)
surface_read({ capabilityId, instanceId? }) → observation output
surface_act({ capabilityId, instanceId?, input,
              invocationId?, confirmationId?, surfaceVersion? })
                                            → action/procedure result
```

Default remains `direct`. Two validators are involved and they check different objects: the **registry** validates capability input exactly as in direct mode (the JSON Schemas ride in the discover payload instead of the tool definitions), and the **adapter** validates the verbs' own envelopes, being the only party that can tell which of the two is wrong (`AS-META-007`).

> [!WARNING]
> **Experimental** (D29). Supported from 0.2 through 0.6, returned to Experimental in 0.7 after two protocol defects in one minor — both in the verb envelope, which the graduation suite never covered, because that suite pins what the mode does *differently* from `direct`. Read the marker as *"opt in, and expect the envelope to move"*, not as unfinished: this is still the library's only answer for a catalog that cannot fit a provider tool block, and every behavior below is conformance-gated. Pin the version and re-read this section on upgrade.

#### Parity rules (`AS-ADAPTER-004`)

Meta mode is a different *projection*, never a different *protocol*.

- **Resolution is identical.** `surface_read`/`surface_act` resolve `(capabilityId, instanceId?)` through the same registry path as a direct tool. When the pair does not resolve to exactly one live registration, the adapter MUST omit `registrationId` and let the registry answer — `AMBIGUOUS_INSTANCE`, `CAPABILITY_NOT_FOUND`, or `COMPONENT_UNMOUNTED`.
  *Why:* a placeholder id is worse than none. An empty string reads as "this exact registration" and returns `STALE_CAPABILITY {retry:"after-refresh"}`, looping the agent against a surface that never changes.

- **One execution path.** Both verbs go through the same invoke helper as direct tools, so staleness binding, dedupe identity, and the wait-mode confirmation retry (D26) behave identically. `surface_act` accepts `invocationId` (transport retry identity), `confirmationId` (two-phase re-submission) and `surfaceVersion` from the caller.

- **The model MUST echo `surfaceVersion` for `destructive` and `external-side-effect` calls** (`AS-META-004`), and the tool description says so. Omitted, the call binds to the live surface — correct for `local-state` work.
  *Why:* a direct tool carries the version of the catalog it was built from; `surface_act` re-resolves per call, so the echoed token is the only equivalent. It is also why a scoped `direct` catalog stays the stronger choice for a least-trusted peer.

- **The catalog is constant**, so `toolset.subscribe` never fires here. Agents notice surface changes by re-running `surface_discover` and comparing `surfaceVersion`. This is the mode's one ergonomic cost.

- **`budget` is meta-only** ([Core API §snapshot](03-core-api.md#snapshot)); passing one with `mode:"direct"` throws at construction. In `surface_discover` the `truncated: {droppedComponents}` marker rides in the payload the model reads, so the party affected by truncation can see it; in direct mode it would drop tools with no marker anywhere, and a silent cap is worse than a loud refusal. The option is **Experimental** on its own account (D6/OQ-4), independently of the mode's status.

- **A refused scope is marked too** (`AS-META-006`, D31). `surface_discover` sets `scopeRejected: {prefixes}` for requested prefixes the configured floor admitted nothing for — the whole request or part of it. A prefix *broader* than the floor is not a refusal; it collapses to the floor's own prefix, which is the narrowing D27 specifies.
  *Why:* truncation is not the only way a payload can be smaller than asked for, and an unmarked empty payload is indistinguishable from an empty surface — where the right next move is to stop asking, not to ask again unscoped.

- **Each verb enforces its own envelope** (`AS-META-007`, D32): `required`, declared scalar types, and `additionalProperties: false`, checked before the registry sees the call, returning `INVALID_INPUT {retry:"with-changes"}` naming the offending property. An unknown key is told it belongs inside `input`.
  *Why:* unenforced, a `surface_act` missing `capabilityId` came back `EXECUTION_FAILED {reason:"handler-error", retry:"no"}` — a caller's mistake reported as an internal defect, carrying the one hint that tells a model to stop rather than fix its call. And a capability argument hoisted beside `input` reached the *capability's* validator, whose message points at a schema that was never the problem.

- **`surface_act.input` is `type: "object"`, and a stringified object is repaired** (`AS-META-008`, D32) — but only when the resolved target's own schema declares an object and the string parses to a plain object, so a capability that genuinely takes a string still receives it. The repair emits a development warning.
  *Why:* untyped, `input` was the only property a provider's constrained decoder could not constrain, so models fell back to the `function_call.arguments` prior their training carries. Typing binds only providers that honor the schema while generating, hence the shim; warning on it keeps a malformed envelope distinguishable from a correct one.

- **The three verbs describe their parameters**, naming where each id comes from and what `scope` accepts. `scope` is described rather than enumerated: its valid tokens are live component types, and inlining them would churn the tool block on every mount — exactly what `AS-META-005` and D28 exist to prevent. The description points at `components[].type` in a previous payload instead.
  *Why:* descriptions are this library's steering channel. `AS-META-004` above leans on one.

### Scope is discovery-only

`scope` filters what a consumer can *see*; it is not an authority boundary. `invoke` does not check scope in either mode, so in meta mode a model that already knows a `capabilityId` can act on it through `surface_act` regardless of scope. That is the honest reading of [Policies & Security §threat model](06-policies-and-security.md#threat-model) — client-side filtering is discovery hygiene, and the server remains the authority for anything that persists.

Within that limit, the configured scope is a **floor** (`AS-ADAPTER-005`, D27): a model-supplied `surface_discover({scope})` may narrow it (`["devices"]` → `["devices.table"]`) but never widen it. An empty array is treated as "unspecified", not "everything"; a request entirely outside the floor returns an empty surface rather than falling back to the floor — and says so via `scopeRejected` (D31), since the floor hiding what was asked for is discovery hygiene, not something to hide in turn. For a least-trusted peer, prefer `direct` with a `scope` — there no tool exists for what the floor hides, which is a boundary rather than a filter.

## WebMCP adapter (Experimental)

`@agent-surface/webmcp` maps the registry onto the emerging `navigator.modelContext` API, treating WebMCP strictly as **transport/discovery** — the application model stays in agent-surface, so WebMCP API drift is absorbed here and nowhere else.

```ts
export function createWebMcpAdapter(options?: {
  snapshotContext?: Omit<SnapshotContext, "consumer">;
  /** Map/curate before exposing; return null to skip a capability. */
  exposeCapability?: (descriptor: AgentCapabilityDescriptorUnion) => WebMcpToolInit | null;
}): AgentSurfaceAdapter;
```

Mapping rules:

- one WebMCP tool per available capability, wire-named, schemas passed through; `registerTool`/context re-provided on every `surface-changed` (coalescing makes this cheap);
- consumer = `{ kind: "webmcp" }`; the user agent is the peer — treat it as the *least* trusted consumer: apps SHOULD scope this adapter (`snapshotContext.scope`); its topology is `remote` by definition and its confirmation mode is fixed `two-phase` (the browser/agent retries; the page still renders its own confirmation UI);
- unavailable capabilities are not registered as WebMCP tools (WebMCP has no disabled state today); the availability reason is lost on this transport — accepted limitation, revisit as the spec evolves;
- if `navigator.modelContext` is absent, `start()` resolves and does nothing (feature-detect, never polyfill).

Caveats (honest): the WebMCP surface area, permission model, and lifecycle are unstable; this adapter tracks them and MUST NOT leak WebMCP types into core. If WebMCP standardizes a richer capability model (availability, confirmation), the adapter grows a richer mapping — the registry already carries the information.

## MCP bridge (Future)

Sketch, intentionally unbuilt: a local MCP server (stdio/HTTP) connected to the page over WebSocket, exposing the surface to out-of-browser MCP clients (IDE agents, desktop assistants). Hard problems it must answer before existing — session pairing and origin auth between server and page, which user session the bridge acts as, confirmation across process boundaries, and multi-tab targeting — keep it out of 0.x. The adapter contract already suffices to build it externally; it becomes first-party only when those answers are specified.

## Testing adapter

`@agent-surface/testing` *is* an adapter in the architectural sense (consumer kind `"test"`, direct registry access) — see [Testing](08-testing.md). It exists partly to prove the seams: anything an adapter needs, the harness needs too.

## Playwright / DOM fallback (Future)

Explicitly **not** part of the core or of v0.x. If ever built, it would be a separate package (`@agent-surface/playwright`) that exposes *registered capabilities* to Playwright-driven agents (resolving capability → test-id interactions), not a generic DOM scanner — the moment it scans, it violates the model this library exists to establish. Documented here only to reserve the position; no API is specified.

## Custom adapter checklist

- [ ] Stable `consumer` identity, unique per adapter instance (invocation-id namespace, D22); scoped `snapshotContext` if the peer is less trusted.
- [ ] Subscribes to `surface-changed`; never serves stale catalogs.
- [ ] Sends `registrationId` (+ `surfaceVersion` for dangerous calls) on invoke.
- [ ] Stable per-attempt `invocationId` (transport retries dedupe); never reused for a different request; `INVOCATION_CONFLICT` treated as a bug signal, not retried by token-stripping.
- [ ] Error mapping preserves `code`/`retry`/`details`; confirmation topology declared (`embedded`/`remote` or explicit mode, D26) and wired to host UI; dispose settles pending waits.
- [ ] Wire-name codec + per-version id map — reverse names through `wireNameMap()`, never by string surgery (D30).
- [ ] Capability state rendered somewhere the model reads it — `description` never carries it (D28).
- [ ] `stop()` fully unsubscribes; safe to start/stop repeatedly (HMR).
- [ ] Covered by tests via `createTestSurface` with your consumer kind.
