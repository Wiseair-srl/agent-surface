# React API

React binds current behavior to compiler-generated declarations:

```tsx
useAgentComponent(devicesTableContract, {
  instanceId: props.instance,
  observations: {
    readState: { read: () => ({ rows, selectedIds }) },
  },
  actions: {
    selectRows: {
      when: () => rows.length > 0,
      execute: ({ ids }) => setSelectedIds(ids),
    },
  },
});
```

The contract owns type, descriptions, schemas, effects, confirmation, tags and policy attachments. Bindings own handlers, current state, availability, preconditions, instance identity and internal metadata.

Registration still occurs in an effect and handlers use latest refs. Strict Mode, remounts, stale references, availability pushes and cleanup retain the lifecycle guarantees documented in [Core](03-core-api.md).

Inline registration overloads and granular capability hooks are removed from the public API. The only public hook path is contract + runtime bindings; private WeakMap proof survives React's latest-ref delegate without becoming forgeable object metadata.

For domain procedures, pass a compiled procedure contract first:

```tsx
useAgentProcedure(devicesDisableContract, bridge.refs.devices.disable, {
  bind: () => ({ deviceIds: selectedIds }),
  when: () => selectedIds.length > 0,
});
```
