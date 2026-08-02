---
layout: home

hero:
  name: agent-surface
  text: A compiler-authorized capability surface for frontend agents
  tagline: Declare semantic capabilities in code, bind them to live UI state, and expose only what the production contract authorizes.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: Architecture
      link: /02-architecture
    - theme: alt
      text: Core API
      link: /03-core-api

features:
  - title: One source of truth
    details: The resolved production graph generates the immutable contract used by the compiler, runtime registry, adapters, CLI, and review snapshot.
  - title: Capabilities, not DOM
    details: Agents receive typed observations, actions, and domain procedure references—never selectors, coordinates, or synthetic interaction.
  - title: Runtime governance
    details: Availability, policy, input validation, confirmation, concurrency, staleness, and audit are enforced on every invocation.
  - title: Deterministic verification
    details: Contract drift and runtime behavior are testable in CI without a model or browser automation.
---

## Choose a path

| Goal | Read |
|---|---|
| Expose the first React capability | [Getting started](/getting-started) |
| Understand the model | [Concepts](/01-concepts) → [Architecture](/02-architecture) |
| Integrate React or oRPC | [React API](/04-react-api) → [oRPC integration](/05-orpc-integration) |
| Review the security boundary | [Policies and security](/06-policies-and-security) → [Limits and non-goals](/11-non-goals) |
| Build an adapter | [Adapters](/09-adapters) → [Errors](/07-errors) |
| Add CI and tests | [Testing](/08-testing) → [CLI](/20-cli) |
| Run the repository example | [Example application](/10-examples) |

## Architectural contract

A capability becomes executable only through this path:

```text
compiled declaration
  → immutable authority
  → privately authorized runtime binding
  → registry validation
  → registry-owned invocation
```

Runtime data can narrow the compiled surface but cannot add identities, effects, schemas, confirmation posture, or policy attachments. Unsupported registrations and tool exposure fail closed. See [Architecture](/02-architecture) for the full guarantee and its boundary.
