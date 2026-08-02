---
"@agent-surface/compiler": patch
"@agent-surface/cli": patch
---

Forward external-contract options from `compileCapabilityContract` to the compiler plugin.

The option existed on the Vite plugin but `compileCapabilityContract` dropped it, so `agent-surface check` and `snapshot` — which both go through it — could not pin or approve an external contract at all. Auto-discovery from the module graph was the only route that worked in CI, which is exactly the route that needed a consumer decision.
