---
layout: home

hero:
  name: agent-surface
  text: An explicit agent surface for your frontend
  tagline: If a component or capability is not explicitly annotated, it does not exist for the agent. Semantic, typed, lifecycle-aware, deny-by-default. Currently a design-phase specification.
  actions:
    - theme: brand
      text: Start with the Vision
      link: /00-vision
    - theme: alt
      text: Conceptual Model
      link: /01-concepts
    - theme: alt
      text: Core API
      link: /03-core-api
    - theme: alt
      text: Devices Page Walkthrough
      link: /10-examples

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

- **"Give me the idea in 10 minutes"** — [Vision](/00-vision), then the five-sentence summary at the top of [Concepts](/01-concepts), then skim the [devices-page walkthrough](/10-examples).
- **"I'm building an app with this"** — [Concepts](/01-concepts) → [React API](/04-react-api) → [oRPC Integration](/05-orpc-integration) → the [devices-page example](/10-examples) (the one runnable, tested app in the repo). For a server-side loop, the [Mastra + assistant-ui wiring guide](/16-mastra-assistant-ui) sketches the shape — hand-written snippets, not an executable package.
- **"I'm implementing the library"** — [Architecture](/02-architecture) → [Core API](/03-core-api) → [Errors](/07-errors) → [Testing](/08-testing) → [Implementation Plan](/14-implementation-plan). The [decision log](/13-open-questions) explains every non-obvious choice; the [Spec Corrections RFC](/18-spec-corrections-rfc) records the P0 protocol corrections (D21–D26) and the [Maintainer Directive](/17-maintainer-directive) is the standing execution contract.
- **"I'm reviewing this for security"** — [Policies & Security](/06-policies-and-security) end to end, then [Non-Goals](/11-non-goals) and the honest-limits notes in the [Completeness Review](/15-completeness-review).

Everything is written with RFC-style **MUST/SHOULD/MAY** where behavior is normative, and labeled **Draft / Experimental / Future** — nothing here is implemented yet, and the docs never pretend otherwise.
