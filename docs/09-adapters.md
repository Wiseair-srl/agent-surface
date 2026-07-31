# 09 — Adapters and Interoperability

> [!NOTE]
> **Status:** adapter contract and embedded toolset **Draft**; WebMCP adapter **Experimental**; MCP bridge and Playwright fallback **Future**. The core model never depends on any protocol here — adapters are replaceable skins over the registry, and the library must stay valuable if any given protocol (WebMCP included) changes or fades.

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
4. MUST supply a stable `invocationId` per external call attempt (e.g. the provider's tool-call id) so transport retries dedupe. Retries of the *same* attempt reuse the id verbatim; a **new** request MUST get a new id — reusing an id for a different request fails `INVOCATION_CONFLICT` ([07](07-errors.md#invocation_conflict)) and MUST NOT be retried by stripping or rotating identity tokens.
5. MUST map results per [07 §adapter mapping](07-errors.md#adapter-mapping-guidance), preserving `code`/`retry`/`details`.
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

- Reversible because the id grammar forbids `_` everywhere ([01 §grammar](01-concepts.md#canonical-id-grammar-draft)).
- **The 64-char budget is enforced, never advisory** (`AS-WIRE-004`, D30). A name that would exceed it is *shortened*: the kept prefix, the marker `_0_`, and a hash of the full id — 54 + 3 + 7 = 64. Deep feature hierarchies plus the `_at_<instanceId>` suffix reach this routinely at application scale (`view:billing.invoices.table.filters.setSelectedRange` in two instances is 73 characters unshortened).
- **Shortening is deterministic** for a given id (`AS-WIRE-005`) and **collision-checked across the emitted catalog** (`AS-WIRE-006`): two entries that would land on the same name are both re-encoded at a longer hash, so the outcome depends on the set of capabilities and not on the order they were projected in. `assignWireNames(entries)` in core does this for any adapter that builds a catalog.
- **`decodeWireName` refuses what it cannot reverse.** Shortened names and `_at_<instanceId>` names return `undefined`, as does anything that does not re-encode byte-identically. Consult `toolset.wireNameMap()` (`AS-WIRE-007`) — it is authoritative, and rule 7 already required keeping it. Returning a plausible-but-wrong id is worse than returning nothing: the canonical id *is* the audit identity, and a host that degrades it to the wire name loses the one thing this library guarantees about a call.

```ts
const canonicalId = toolset.wireNameMap().get(toolCall.name);
// NOT: decodeWireName(toolCall.name) ?? toolCall.name  ← silent identity loss
```

## Embedded toolset adapter (Draft)

The primary v0.1 consumer: an agent loop running in the host app (any provider). Core's `createAgentToolset` ([03 §toolset](03-core-api.md#toolset)) does the projection; the host maps `AgentTool[]` to its SDK. This is deliberately framework-neutral — the same catalog plugs into Vercel AI SDK `streamText`, a Mastra agent (forwarded per turn as client tools), LangGraph, or assistant-ui's model context. There is no `@agent-surface/mastra` package because none is needed; the wiring for that stack is sketched in [16-mastra-assistant-ui.md](16-mastra-assistant-ui.md) (hand-written snippets — the executable example is the embedded loop in `examples/devices-app`). The description template prepends plane/effect so models can tell reads from view changes from authoritative mutations:

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
- `state.note` carries a procedure reference's contextual `describe()` output ([05 §snapshot-descriptor](05-orpc-integration.md#snapshot-descriptor)). It is one string; a host that wants structure should read `snapshot.procedures[].boundFields` directly.

### Confirmation topology

`createAgentToolset` requires a declared topology (or an explicit `confirmations` mode); omitting both throws. The mapping and its consequences (D26, [18 §correction 6](18-spec-corrections-rfc.md#correction-6--confirmation-mode-is-declared-by-topology-never-defaulted-globally-d26)):

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
| beyond ~200 | `meta` | Tool-block size stops tracking the surface (`AS-META-005`), and tool-selection accuracy stops degrading on a flat list of hundreds. Costs one round trip before the first act. |

These are starting points from catalog-size measurements, not thresholds the library enforces; a host that measures its own model's behavior should trust that instead. Automatic switching remains deliberately unspecified (OQ-9).

### Meta-tools mode

For large surfaces, three fixed tools replace the per-capability catalog, trading provider-native input typing for a constant tool count and lazy discovery:

```text
surface_discover({ scope? })                → snapshot catalog (JSON)
surface_read({ capabilityId, instanceId? }) → observation output
surface_act({ capabilityId, instanceId?, input,
              invocationId?, confirmationId?, surfaceVersion? })
                                            → action/procedure result
```

Inputs are validated by the registry exactly as in direct mode (the JSON Schemas ride in the discover payload instead of the tool definitions). Default remains `direct`.

**Supported since 0.2** (D29). It graduated on the conformance suite that pins what makes it different — `AS-META-001` (a model scope narrows the configured floor, never widens it), `AS-META-002` (a disjoint scope yields empty, never the floor), `AS-META-003` (a truncated `surface_discover` payload is marked and still a valid snapshot), `AS-META-004` (`surface_act` keeps direct-mode confirmation and staleness semantics), `AS-META-005` (tool-block size is invariant in the number of registered capabilities). An experimental marker on the library's only answer for a large catalog meant no production host could adopt it in the situation it was built for.

Normative parity rules (`AS-ADAPTER-004`) — meta mode is a different *projection*, never a different *protocol*:

- **Resolution is identical.** `surface_read`/`surface_act` resolve `(capabilityId, instanceId?)` through the same registry path as a direct tool. When the pair does not resolve to exactly one live registration, the adapter MUST omit `registrationId` and let the registry answer: `AMBIGUOUS_INSTANCE` (with the instance list, `retry:"with-changes"`), `CAPABILITY_NOT_FOUND`, or `COMPONENT_UNMOUNTED`. An adapter MUST NOT substitute a placeholder id — an empty string reads as "this exact registration", which returns `STALE_CAPABILITY {retry:"after-refresh"}` and loops the agent against an unchanged surface.
- **One execution path.** Both verbs go through the same invoke helper as direct tools, so staleness binding, dedupe identity, and the wait-mode confirmation retry (D26) behave the same. `surface_act` accepts `invocationId` (transport retry identity), `confirmationId` (two-phase re-submission) and `surfaceVersion` from the caller.
- **Staleness needs the version echoed back** (`AS-META-004`). A direct tool carries the `surfaceVersion` of the catalog it was built from, so a destructive call planned against a surface that has since moved fails `STALE_CAPABILITY`. `surface_act` re-resolves per call, so the equivalent token is the `surfaceVersion` the model read from `surface_discover` — it MUST echo it for destructive and external-side-effect calls, and the tool description says so. Omitted, the call binds to the live surface: correct for `local-state` work, and the reason a scoped `direct` catalog remains the stronger choice for a least-trusted peer.
- **The catalog is constant**, so `toolset.subscribe` never fires in meta mode — there is nothing that could change. Agents notice surface changes by re-running `surface_discover` and comparing `surfaceVersion`. This is the one ergonomic cost of the mode, stated rather than papered over.
- **`budget` is meta-only** ([03 §snapshot](03-core-api.md#snapshot)). In `surface_discover` the `truncated: {droppedComponents}` marker travels in the payload the model reads, so truncation is visible to the party affected by it. Passing a budget with `mode:"direct"` throws at construction: there it would drop tools from the catalog with no marker anywhere, and a silent cap is worse than a loud refusal. The option stays **Experimental** (its shape is still open, D6/OQ-4) even though the mode is supported; what `AS-META-003` pins is that when a budget *is* set, the payload says so and remains a valid snapshot.
- **A refused scope is marked too** (`AS-META-006`, D31). Truncation is not the only way the payload can be smaller than the model asked for: prefixes outside the configured floor are dropped as well, and an unmarked empty payload is indistinguishable from an empty surface — where the right next move is to stop asking, not to ask again unscoped. `surface_discover` therefore sets `scopeRejected: {prefixes}` on the requested prefixes the floor admitted nothing for, whether that is the whole request or part of it. A prefix *broader* than the floor is not a refusal: it collapses to the floor's own prefix, which is the narrowing D27 specifies.
- **The three verbs describe their parameters.** Descriptions are this library's steering channel — `surface_act`'s says to echo `surfaceVersion`, and `AS-META-004` leans on it — so meta mode spends the fixed bytes to say where each id comes from and what `scope` accepts. `scope` is described rather than enumerated on purpose: valid tokens are live component types, and inlining them would make the tool block change on every mount, which is exactly what `AS-META-005` and D28 exist to prevent. The description points at `components[].type` in a previous payload instead.

### Scope is discovery-only

`scope` filters what a consumer can *see*; it is not an authority boundary. `invoke` does not check scope in either mode, so in meta mode a model that already knows a `capabilityId` can act on it through `surface_act` regardless of scope. That is the honest reading of [06 §threat model](06-policies-and-security.md#threat-model) — client-side filtering is discovery hygiene, and the server remains the authority for anything that persists.

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

Sketch, intentionally unbuilt: a local MCP server (stdio/HTTP) connected to the page over WebSocket, exposing the surface to out-of-browser MCP clients (IDE agents, desktop assistants). Hard problems it must answer before existing — session pairing and origin auth between server and page, which user session the bridge acts as, confirmation across process boundaries, and multi-tab targeting — make it a poor v0.1 candidate. The adapter contract already suffices to build it externally; it becomes first-party only when those answers are specified.

## Testing adapter

`@agent-surface/testing` *is* an adapter in the architectural sense (consumer kind `"test"`, direct registry access) — see [08-testing.md](08-testing.md). It exists partly to prove the seams: anything an adapter needs, the harness needs too.

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
