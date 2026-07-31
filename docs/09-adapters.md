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

Provider tool-name alphabets are restricted (typically `[a-zA-Z0-9_-]`, length-capped). Canonical codec (Draft):

```text
encode(id): ":" → "_"    "." → "__"          e.g. view:devices.table.selectRows
                                              ⇒ view_devices__table__selectRows
decode(name): first "_" not part of "__" splits the plane; "__" → "."
```

- Reversible because the id grammar forbids `_` everywhere ([01 §grammar](01-concepts.md#canonical-id-grammar-draft)).
- Names longer than 64 chars: truncate to 56 + `_` + 7-char hash of the full id; the adapter's id↔name map resolves these (decode alone no longer suffices — the map is authoritative anyway, rule 7).

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

### Confirmation topology

`createAgentToolset` requires a declared topology (or an explicit `confirmations` mode); omitting both throws. The mapping and its consequences (D26, [18 §correction 6](18-spec-corrections-rfc.md#correction-6--confirmation-mode-is-declared-by-topology-never-defaulted-globally-d26)):

| Topology | Default mode | Why |
|---|---|---|
| `embedded` (loop in/next to the page) | `wait` | The run can block on the user cheaply; the model sees one call → one result. |
| `remote` (server-side loop, per-turn frontend tools) | `two-phase` | Wait-mode would hold the provider run open across a human approval: transport/stream timeouts, broken reconnects, billed idle time. The model receives `CONFIRMATION_REQUIRED` and retries next turn with the `confirmationId`. |

A remote adapter MAY opt into `wait` explicitly — it then owns its transport-timeout story and MUST bound the wait below the transport's own timeout. Recovery after reconnect: re-snapshot; a confirmation approved while disconnected is retried by id within its TTL, an expired one restarts the cycle (`CONFIRMATION_INVALID {reason:"expired"}` → fresh `CONFIRMATION_REQUIRED`). Shutdown is deterministic: `toolset.dispose()` aborts in-flight wait-mode waits (the pending `CONFIRMATION_REQUIRED` result is returned as-is); `registry.dispose()` expires all pending records.

### Meta-tools mode (Experimental)

For large surfaces, three fixed tools replace the per-capability catalog, trading provider-native input typing for a constant tool count and lazy discovery:

```text
surface_discover({ scope? })                → snapshot catalog (JSON)
surface_read({ capabilityId, instanceId? }) → observation output
surface_act({ capabilityId, instanceId?, input, invocationId?, confirmationId? })
                                            → action/procedure result
```

Inputs are validated by the registry exactly as in direct mode (the JSON Schemas ride in the discover payload instead of the tool definitions). Default remains `direct`; a future heuristic ("switch above N capabilities") is deliberately not specified yet — measure first.

Normative parity rules (`AS-ADAPTER-004`) — meta mode is a different *projection*, never a different *protocol*:

- **Resolution is identical.** `surface_read`/`surface_act` resolve `(capabilityId, instanceId?)` through the same registry path as a direct tool. When the pair does not resolve to exactly one live registration, the adapter MUST omit `registrationId` and let the registry answer: `AMBIGUOUS_INSTANCE` (with the instance list, `retry:"with-changes"`), `CAPABILITY_NOT_FOUND`, or `COMPONENT_UNMOUNTED`. An adapter MUST NOT substitute a placeholder id — an empty string reads as "this exact registration", which returns `STALE_CAPABILITY {retry:"after-refresh"}` and loops the agent against an unchanged surface.
- **One execution path.** Both verbs go through the same invoke helper as direct tools, so staleness binding, dedupe identity, and the wait-mode confirmation retry (D26) behave the same. `surface_act` accepts `invocationId` (transport retry identity) and `confirmationId` (two-phase re-submission) from the caller.
- **The catalog is constant**, so `toolset.subscribe` never fires in meta mode — there is nothing that could change. Agents notice surface changes by re-running `surface_discover` and comparing `surfaceVersion`; a stale `surfaceVersion` on an act is rejected as usual. This is the one ergonomic cost of the mode, stated rather than papered over.
- **`budget` is meta-only** ([03 §snapshot](03-core-api.md#snapshot)). In `surface_discover` the `truncated: {droppedComponents}` marker travels in the payload the model reads, so truncation is visible to the party affected by it. Passing a budget with `mode:"direct"` throws at construction: there it would drop tools from the catalog with no marker anywhere, and a silent cap is worse than a loud refusal.

### Scope is discovery-only

`scope` filters what a consumer can *see*; it is not an authority boundary. `invoke` does not check scope in either mode, so in meta mode a model that already knows a `capabilityId` can act on it through `surface_act` regardless of scope. That is the honest reading of [06 §threat model](06-policies-and-security.md#threat-model) — client-side filtering is discovery hygiene, and the server remains the authority for anything that persists.

Within that limit, the configured scope is a **floor** (`AS-ADAPTER-005`, D27): a model-supplied `surface_discover({scope})` may narrow it (`["devices"]` → `["devices.table"]`) but never widen it. An empty array is treated as "unspecified", not "everything"; a request entirely outside the floor returns an empty surface rather than falling back to the floor. For a least-trusted peer, prefer `direct` with a `scope` — there no tool exists for what the floor hides, which is a boundary rather than a filter.

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
- [ ] Wire-name codec + per-version id map.
- [ ] `stop()` fully unsubscribes; safe to start/stop repeatedly (HMR).
- [ ] Covered by tests via `createTestSurface` with your consumer kind.
