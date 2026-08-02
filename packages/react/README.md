# `@agent-surface/react`

Lifecycle-correct runtime bindings for compiler-generated contracts.

```tsx
useAgentComponent(devicesTableContract, {
  observations: { readState: { read: () => state } },
  actions: { selectRows: { execute: ({ ids }) => setSelected(ids) } },
});
```

Static identity/governance stays in the contract; handlers, state and availability stay in React. See [React API](../../docs/04-react-api.md).
