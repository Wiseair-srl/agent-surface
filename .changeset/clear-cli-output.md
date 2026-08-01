---
"@agent-surface/core": patch
"@agent-surface/react": patch
"@agent-surface/orpc": patch
"@agent-surface/testing": patch
"@agent-surface/webmcp": patch
"@agent-surface/cli": patch
---

Make large CLI reports useful at a glance.

`inspect --depth static` groups capabilities by component and unread sites by file/reason while preserving every copyable allowlist key. `--detail` restores raw origins and diagnostics.

`check` leads with a PASS/FAIL health matrix. Passing non-gating inventories stay summarized unless `--detail` is requested. Open-handle warnings are structured instead of one long line.
