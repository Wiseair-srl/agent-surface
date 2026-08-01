---
layout: home

hero:
  name: agent-surface
  text: An explicit agent surface for your frontend
  tagline: If a component or capability is not explicitly annotated, it does not exist for the agent. Semantic, typed, lifecycle-aware, deny-by-default. Specification and implementation, published as 0.x.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: Why this exists
      link: /00-vision
    - theme: alt
      text: Conceptual model
      link: /01-concepts
    - theme: alt
      text: Core API
      link: /03-core-api

features:
  - title: Capabilities, not DOM
    details: Components register semantic observations and actions (view:devices.table.selectRows) — never clicks, selectors, coordinates, or screenshots.
  - title: Two planes, never blurred
    details: Domain operations stay oRPC procedures exposed via orpc-agent; the frontend only references them contextually, with UI-bound inputs. No duplication, ever.
  - title: Governed by the runtime
    details: Composable policies, single-use confirmation evidence, typed errors, staleness rejection, audit events. The runtime decides — not the model.
  - title: Testable without an LLM
    details: The surface is a typed contract — discovery, invocation, confirmation, and staleness are asserted deterministically with the testing package.
---

## How to read these docs

Pick the path that matches why you're here:

- **"I want to try it"** — [Getting Started](/getting-started): install, annotate one component, assert what you exposed. Fifteen minutes, no backend.
- **"Give me the idea in 10 minutes"** — [Vision](/00-vision), then the five-sentence summary at the top of [Concepts](/01-concepts), then skim the [devices-page walkthrough](/10-examples).
- **"I'm building an app with this"** — [Concepts](/01-concepts) → [React API](/04-react-api) → [oRPC Integration](/05-orpc-integration) → the [devices-page example](/10-examples), the one runnable, tested app in the repo. Then gate it in CI with [Testing](/08-testing) and the [CLI](/20-cli). For a server-side loop, the [Mastra + assistant-ui guide](/16-mastra-assistant-ui) sketches the shape — hand-written snippets, not an executable package.
- **"I'm reviewing this for security"** — [Policies & Security](/06-policies-and-security) end to end, then [Non-Goals](/11-non-goals) and the honest-limits notes in the [Completeness Review](/project/15-completeness-review).
- **"I'm implementing the library"** — [Architecture](/02-architecture) → [Core API](/03-core-api) → [Errors](/07-errors) → [Testing](/08-testing). The [decision log](/project/13-open-questions) explains every non-obvious choice, the [RFCs](/project/18-spec-corrections-rfc) record the corrections that reshaped the protocol, and the [Maintainer Directive](/project/17-maintainer-directive) is the standing execution contract.

Everything is written with RFC-style **MUST/SHOULD/MAY** where behavior is normative, and labeled **Draft / Experimental / Future**. Nothing is *Stable* yet. Where the docs describe something that is not built — a deferred decision, a topology without a runnable example — they say so in place rather than implying coverage.
