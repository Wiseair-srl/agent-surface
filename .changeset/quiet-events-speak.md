---
"@agent-surface/core": patch
"@agent-surface/react": patch
"@agent-surface/orpc": patch
"@agent-surface/testing": patch
"@agent-surface/webmcp": patch
"@agent-surface/cli": patch
---

Fixes scenario diagnostics and jsdom event compatibility. React mount failures
now retain component and JavaScript stack context, empty errors get a useful
fallback, and global events use jsdom's realm so Radix overlays mount correctly.
