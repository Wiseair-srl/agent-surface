# Security policy

agent-surface is a **deny-by-default control plane for frontend agent capabilities**: v0.1 is implemented in-repo but **not yet published to npm**. Reports may target the design (the normative specification in `docs/`) or the code under `packages/` — we want both.

## Reporting

**Do not open public issues for exploitable problems.**

- Preferred: GitHub private vulnerability reporting ("Report a vulnerability") on this repository.
- We aim to acknowledge within **72 hours** and give an assessment within **14 days**. Coordinated disclosure: we'll agree on a timeline with you; default publication is upon fix release (or 90 days, whichever is sooner).
- No bug bounty exists; credit is given in advisories unless you prefer otherwise.

In scope: anything that lets an agent do what the documentation says it cannot. Concretely — bypassing the [deny-by-default requirements](docs/06-policies-and-security.md#the-deny-by-default-requirements-mapped) (1–12); confirmation **replay** or **bait-and-switch** within the [documented protocol](docs/06-policies-and-security.md#confirmation) (evidence is digest-bound to the validated effective input, single-use, TTL- and consumer-bound); `internal` metadata reaching a snapshot, error, confirmation, or model tool; hidden-authority failures becoming distinguishable from nonexistence; staleness tokens being bypassable; error payloads leaking stacks, queries, permission names, or raw values; an adapter weakening identity, staleness, or confirmation without a conformance failure.

Out of scope: vulnerabilities in applications built with the library (report to those projects); in React, oRPC, orpc-agent, or model providers; **prompt-injection occurrence** (the library bounds what an injected model can reach — it does not prevent injection); and **hostile same-realm JavaScript**, which is explicitly [out of the threat model](docs/06-policies-and-security.md#threat-model) — a malicious script in the page can call the registry like any other code.

## What the library does and does not claim

Read before reporting, to calibrate expectations:

- **The browser is not a security boundary.** Client policies provide honest discovery, safer UX, contextual gating, confirmation, and audit. For domain operations the **server re-checks** authentication, authorization, tenant, input, rate, and approval on every call. A finding of the form "the client can be bypassed with DevTools" is by-design, not a vulnerability — unless the docs claim otherwise somewhere, in which case the doc is the bug.
- It does **not** claim exactly-once execution (the idempotency window is [bounded](docs/11-non-goals.md#known-limitations-honest-normative--directive-94)), forcible cancellation (cooperative `AbortSignal` only), or containment of untrusted page code.
- The honest limitation list is [maintained deliberately](docs/11-non-goals.md#known-limitations-honest-normative--directive-94); contradicting it in code *is* a valid report.

## Supported versions

Pre-1.0: only the latest published minor receives fixes. Post-1.0, the policy in [12-roadmap.md](docs/12-roadmap.md) applies: latest minor receives fixes; the previous minor receives critical fixes for 6 months.

## Design-phase security review

Structured review is actively wanted. Highest-value targets: the [threat model](docs/06-policies-and-security.md#threat-model), the [10-phase invocation pipeline](docs/02-architecture.md#invocation-pipeline-normative-order), and the [confirmation protocol](docs/06-policies-and-security.md#confirmation) — the three places where a subtle ordering mistake becomes an authority mistake (see [18-spec-corrections-rfc.md](docs/18-spec-corrections-rfc.md) for the P0 corrections already found this way). Non-exploitable design critique is welcome as a public issue labeled `security-design`.

Every normative security guarantee is expected to have a named conformance test: `spec/conformance.json` maps requirement IDs to tests, and `pnpm check:conformance` fails the build when one is missing. A report that a guarantee is *untested* is as useful as one that it is broken.
