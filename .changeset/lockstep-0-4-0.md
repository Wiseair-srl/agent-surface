---
"@agent-surface/core": minor
"@agent-surface/react": minor
"@agent-surface/orpc": minor
"@agent-surface/testing": minor
"@agent-surface/webmcp": minor
---

Release all packages together at 0.4.0.

The discovery-honesty changes (D31) land in `core` only, but the packages ship in lockstep while we are pre-1.0 — see `.changeset/README.md`. The `AgentSurfaceSnapshot` shape is what every adapter reads, so a version that identifies the whole surface contract is more useful than four packages trailing a minor behind it.
