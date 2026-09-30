---
"@agent-surface/cli": minor
"@agent-surface/compiler": minor
"@agent-surface/core": minor
"@agent-surface/orpc": minor
"@agent-surface/react": minor
"@agent-surface/testing": minor
"@agent-surface/webmcp": minor
---

WebMCP adapter: `stop()` now withdraws every exposed tool and is idempotent; tools are reconciled incrementally with `registerTool`/`unregisterTool` when the browser supports them (full `provideContext` otherwise); a new opt-in `confirm` option completes required confirmations in page through `client.requestUserInteraction`; observations and read-only effects carry `annotations.readOnlyHint`. Zero-argument tool calls now forward `{}` instead of dropping it, which previously failed `INVALID_INPUT` on actions. Docs record the declarative WebMCP API as a non-goal and pin the targeted WebMCP surface.
