# @agent-surface/react

React bindings for [agent-surface](https://github.com/Wiseair-srl/agent-surface): lifecycle-correct hooks that tie capability registrations to component mounts. Registration happens once per mount in an effect; handlers are read through a ref at invocation time — no dependency arrays, no `useCallback`, no stale closures. Strict Mode, Suspense, SSR and concurrent rendering all work without special cases.

Docs: https://agent-surface-docs.vercel.app

## Install

```bash
pnpm add @agent-surface/core @agent-surface/react
```

## Use

```tsx
import { AgentSurfaceProvider, useAgentComponent, usePendingConfirmations } from "@agent-surface/react";
import { action, observation } from "@agent-surface/core";

function DevicesTable() {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  useAgentComponent({
    type: "devices.table",
    description: "Table of the devices visible on the current page",
    observations: {
      readState: observation({
        description: "Visible rows and selection",
        output: TableStateSchema,
        read: () => ({ visibleRows, selectedIds }),
      }),
    },
    actions: {
      selectRows: action({
        description: "Replace the current row selection",
        input: SelectRowsSchema,
        effect: "local-state",
        execute: ({ ids }) => setSelectedIds(ids),
      }),
    },
  });
  return <Table />;
}
```

While mounted, an agent sees two typed capabilities; on unmount they are gone and late invocations fail with typed `COMPONENT_UNMOUNTED`. Availability (`when`, `enabled`) is re-evaluated per commit and pushed to the registry.

Full specification: [docs](https://github.com/Wiseair-srl/agent-surface/tree/main/docs).

MIT © Wiseair S.r.l.
