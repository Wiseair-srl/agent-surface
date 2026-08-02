# `@agent-surface/core`

Framework-neutral contracts, registry, policy, confirmation, invocation and exposure gateway.

```ts
const contract = defineAgentComponentContract({
  type: "devices.table",
  description: "Device table",
  observations: { readState: observationContract({ description: "State", output }) },
  actions: { selectRows: actionContract({ description: "Select", input, effect: "local-state" }) },
});

const registry = createAgentSurfaceRegistry({ manifest });
registry.register(contract.bind({
  observations: { readState: { read } },
  actions: { selectRows: { execute } },
}));
```

With a compiler manifest installed, raw/unknown/stale/mismatched registrations fail closed. Use `createAgentExposureGateway()` at final provider/MCP assembly.

See [Core API](../../docs/03-core-api.md).
