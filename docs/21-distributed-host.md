# Remote browser sessions and governed domain calls

The browser retains its live registry. A long-running agent host receives announcements and sends correlated calls over the application's authenticated transport. Short-lived backend handlers retain domain authorization, approval, execution, and receipts.

## Browser session

```ts
import { createBrowserSurfaceSession } from "@agent-surface/core/host";

const session = createBrowserSurfaceSession({
  registry, // already created with a compiler-generated authority
  identity: {
    appId: "console",
    buildId: BUILD_ID,
    sessionId: authenticatedSessionBinding, // opaque ID, not a credential
    tabId: crypto.randomUUID(), // new for every document lifetime
  },
  consumer: { id: authenticatedUserId, kind: "embedded" },
});

transport.send(session.connect(crypto.randomUUID()));
const unsubscribe = session.subscribe((announcement) => transport.send(announcement));
transport.onCall(async (call) => transport.send(await session.invoke(call)));
transport.onDisconnect(() => session.disconnect());
// On reconnect, call connect() with a NEW connection ID and send its announcement.
// On unmount/logout: unsubscribe(); session.dispose();
```

`BrowserSurfaceAnnouncement` carries protocol version 1, the four identity fields, the connection ID, and the current snapshot. Snapshots contain stable descriptions/schemas plus current availability, registration IDs, and the surface version. Registry changes publish refreshed announcements. An explicit `announcement()` obtains a fresh snapshot; it returns `null` while disconnected, expired, or disposed.

`BrowserSurfaceCall` carries the same identity and connection ID, `runId`, `toolCallId`, and `invocation`. The invocation requires `invocationId`, `capabilityId`, `registrationId`, and `surfaceVersion`; ordinary invocation input, instance, and confirmation fields remain supported. Even reads require the current revision. Only capabilities currently discoverable to the configured consumer can be dispatched.

`BrowserSurfaceResult` echoes the dispatch connection/run/tool/invocation IDs. Its `result` is an ordinary `AgentInvocationResult` or `{ status: "rejected", reason }`. Reasons are `invalid-call`, `wrong-session`, `disconnected`, `stale-surface`, `invocation-conflict`, `capacity-exceeded`, and `session-expired`. Wrong-tab and stale calls never reach the registry. Calls pending at disconnect are aborted; an action already started may have taken effect despite cancellation. Reconcile that outcome instead of automatically replaying it.

The host MUST authenticate announcements and compare them with known build artifacts. A browser-supplied build ID, schema, or hash grants no authority. The host MUST bind each outstanding call/result to the authenticated connection, session, tab, run, tool call, and invocation. Reject unsolicited or changed duplicate results. Never transfer a pending mutation to another tab. Remove browser tools when no live session is available; headless runs receive no view tools.

## Bounded replay protection

Within one adapter lifetime, identical invocation IDs and request envelopes join in flight or return the frozen recorded result. Reusing the ID with changed input, run, tool call, or connection fails. Results are retained even when registration state subsequently changes. Local confirmation retries therefore use a fresh invocation ID and their issued confirmation evidence.

The adapter admits at most `maxEntries` calls, connection IDs, and listeners in each respective collection (default 1,000). It never evicts accepted calls to admit new ones. The entire adapter expires after `ttlMs` (default 30 minutes). Expiry clears retained entries/listeners on the next API call or registry event and refuses subsequent execution. Call envelopes are capped at 262,144 serialized characters. Disconnect/dispose abort pending work; dispose clears retained state immediately. Pending handlers remain subject to registry timeouts.

When full or expired, quiesce outstanding calls, reconcile receipts, dispose the adapter, and establish a fresh session identity. IDs must never be reused across document/session incarnations. Reload loses the browser's in-memory deduplication and confirmation state. Completed-but-unacknowledged actions remain ambiguous after reload: neither this adapter nor reconnect establishes exactly-once UI effects.

## Governed contextual procedures

Generate the browser manifest from the backend's portable descriptors, using the backend's client contract from `@orpc-agent/core/client`:

```ts
import { createOrpcAgentManifest, createGovernedOrpcAgentBridge } from "@agent-surface/orpc";

const descriptors = await capabilityClient.describe(); // authenticated, caller-scoped
const manifest = createOrpcAgentManifest(descriptors);
const bridge = createGovernedOrpcAgentBridge<DomainClientContract>({
  client: capabilityClient,
  manifest,
  onOutcome(outcome, info) {
    // Application observer: correlate approvals and invalidate after completed receipts.
    receiptEvents.publish({ outcome, invocationId: info.invocationId });
  },
});
registry.setProcedureExecutor(bridge.executor);
```

`DomainClientContract` is a type-only oRPC client/router shape. Existing compiler-generated procedure bindings continue to use `bridge.refs`, with bound target/revision fields removed from model input. Input is reconstructed and validated in the registry before the governed executor calls the backend. The client is structural: browser bundles import no backend handlers or registry implementation.

`createOrpcAgentManifest` maps portable `none`/`read` effects to `server-query`, `write` to `server-mutation`, and external/destructive effects to their matching domain effects. It copies schemas and retains `capabilityId` and `contractDigest` for invocation. Model output stays opaque unless a portable model-output schema is explicitly declared; an ordinary RPC output schema may be incompatible with redaction.

Manifest keys and Surface IDs retain the existing router-path convention (`domain:forms.edit`). If the backend overrides the canonical capability ID, use `manifest.tools[path].capabilityId` when composing/deduplicating domain and contextual tools. The executor sends that canonical ID to the backend. Paths with duplicates, prefix conflicts, or unsafe prototype segments are rejected.

The manifest is metadata, not authorization. A static generated artifact may be cached per build; actor-filtered discovery MUST remain scoped to the caller. The server gateway fixes agent initiation provenance and exposure surface, verifies the digest, applies fresh authorization, and owns approval state. The browser cannot request `surface: direct`. Contextual visibility and backend approval can therefore coexist. Keep one chosen model presentation per canonical operation in a composed scope.

## Approval and reconciliation

`requiresApproval` is a server hint, independent of the local confirmation floor. A destructive/external effect or explicit browser confirmation policy can still require local confirmation. That confirmation cannot satisfy a persisted domain approval.

The bridge forwards a stable invocation ID and digest, returns completed output, and reports:

| Domain result | Surface result | Host action |
| --- | --- | --- |
| `approval-required` | `DOMAIN_APPROVAL_REQUIRED`, retry `no`; details contain invocation/execution/approval IDs | Persist the run/tool/approval association. Use an authenticated application decision endpoint, then resume through the backend with fresh requester authority. |
| `outcome-unknown`, lost response, or mismatched response identity | `DOMAIN_OUTCOME_UNKNOWN`, retry `no`; details contain invocation ID | Reconcile through `getInvocation`; never assume the effect failed. |
| `failed` / `cancelled` | Sanitized authorization/execution error, retry `no` | Apply application failure handling. |

`onOutcome` is a synchronous observer, not durable storage or an acknowledgment barrier. Observer exceptions do not erase completed domain receipts. Persist dispatch identity and host continuation state before network execution; use backend receipts as the source of truth after interruption. Approval resumption is not a browser confirmation retry and must not redispatch the UI mutation. Approval decisions themselves are never model tools.

## Migration

The ordinary `createOrpcAgentBridge({ client, manifest })` remains available for existing applications. It cannot itself establish agent provenance for ordinary RPC routes. Model-initiated domain calls should adopt the governed bridge and an authenticated server-fixed agent gateway.

Handle the two new domain error codes explicitly. Existing server `APPROVAL_REQUIRED` errors now map to `DOMAIN_APPROVAL_REQUIRED` with `approvalId`, rather than local `CONFIRMATION_REQUIRED` with `confirmationId`. `requiresApproval` no longer forces a browser confirmation; add `confirmation: "required"` to a contextual binding if the product also needs that local prompt. Regenerate/review compiled contracts when changing this confirmation posture.

## Decision D43 — distributed boundaries

**Accepted:** publish the session adapter as `@agent-surface/core/host` and manifest/governed adapters through `@agent-surface/orpc`. Reuse the existing authorized registry and router-path identity. Treat authenticated transport, known build verification, durable host ownership, domain approvals, and result reconciliation as explicit application/backend responsibilities.

**Consequences:** strict registration/revision/connection checks; bounded adapter lifetime without replay-safe eviction; no cross-reload guarantee; backend approval distinct from local confirmation. Tests cover AS-HOST-001/002/003 and AS-GOVERNED-001/002. No AWS, React, Mastra, or transport implementation is required by these additions.
