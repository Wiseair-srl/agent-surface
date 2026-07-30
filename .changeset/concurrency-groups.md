---
"@agent-surface/core": minor
---

Implement configurable concurrency groups (D25, `AS-CONC-001` — the last requirement still marked `specified`).

```ts
action({ /* … */ concurrency: { mode: "capability" } })
```

- `AgentConcurrency = {mode:"instance"} | {mode:"capability"} | {mode:"key";key} | {mode:"parallel";max}`, each with an optional per-group `queueDepth`.
- Default is unchanged: `{mode:"instance"}`, one FIFO queue per registration.
- `parallel` requires an integer `max ≥ 1`; invalid groups throw `AgentSurfaceDefinitionError` at registration rather than degrading at runtime.
- Groups are created on demand and dropped when idle, so the runtime holds one entry per currently contended group.
- **Behavior change:** procedure references are now admitted through one group per procedure identity per referencing registration. Repeat calls of the same domain operation serialize client-side where they previously ran unbounded-parallel; a view action on the same component is never blocked by an in-flight domain call. Opt out with an explicit `concurrency` on the binding.
