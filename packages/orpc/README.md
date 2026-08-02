# `@agent-surface/orpc`

Bind compiler-declared domain procedures to authoritative oRPC client paths.

```tsx
useAgentProcedure(devicesDisableContract, bridge.refs.devices.disable, {
  bind: () => ({ deviceIds: selectedIds }),
  when: () => selectedIds.length > 0,
});
```

The compiled contract owns identity/schemas/effect/confirmation. The bridge owns execution and server error mapping. See [oRPC integration](../../docs/05-orpc-integration.md).
