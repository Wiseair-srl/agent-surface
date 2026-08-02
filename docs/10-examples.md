# Example application

[`examples/devices-app`](https://github.com/Wiseair-srl/agent-surface/tree/main/examples/devices-app) demonstrates the complete architecture:

- [`contracts.ts`](https://github.com/Wiseair-srl/agent-surface/blob/main/examples/devices-app/src/agent/contracts.ts) declares view and domain capability identity;
- production Vite config runs `agentSurface()`;
- the virtual manifest is installed in the registry at the production composition root;
- React components bind handlers and live state to imported contracts;
- the oRPC bridge binds a generated domain contract to the authoritative client;
- `.agent-surface/contract.json` is the committed repository-review artifact;
- app tests use `@agent-surface/testing` for deterministic runtime behavior.

Build and inspect it:

```bash
pnpm --filter devices-app-example exec vite build
pnpm --filter devices-app-example exec agent-surface inspect
pnpm --filter devices-app-example exec agent-surface check
```

The scripted test covers filter → read → select → confirm → authoritative mutation → verify without an LLM. Runtime tests prove behavior; the compiler artifact proves repository inventory.
