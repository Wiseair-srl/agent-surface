---
"@agent-surface/cli": minor
"@agent-surface/compiler": minor
"@agent-surface/core": minor
"@agent-surface/orpc": minor
"@agent-surface/react": minor
"@agent-surface/testing": minor
"@agent-surface/webmcp": minor
---

WebMCP confirmations now complete without the `confirm` hook. Its tools have no slot for a `confirmationId`, so the two-phase fallback could never succeed: each retry after approval opened a new confirmation. When `confirm` doesn't apply (not set, no `requestUserInteraction`, or the UI throws), `execute` now waits for the host's confirmation UI and retries with the evidence. Denial or expiry returns `CONFIRMATION_INVALID`; `stop()` aborts pending waits.
