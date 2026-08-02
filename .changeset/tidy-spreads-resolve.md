---
"@agent-surface/core": patch
"@agent-surface/react": patch
"@agent-surface/orpc": patch
"@agent-surface/testing": patch
"@agent-surface/webmcp": patch
"@agent-surface/cli": patch
---

Fixes static extraction of conditional capabilities contributed through readable
spreads inside `observations` and `actions`. Their identities now enter the
catalog as partial instead of remaining unresolved.
