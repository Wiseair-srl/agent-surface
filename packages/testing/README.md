# @agent-surface/testing

Deterministic testing toolkit for [agent-surface](https://github.com/Wiseair-srl/agent-surface). The surface is a typed contract; contracts are tested deterministically — **no test in this ecosystem requires an LLM**.

Docs: https://agent-surface-docs.vercel.app

## Install

```bash
pnpm add -D @agent-surface/testing
```

## Use

```tsx
import { renderAgentSurface } from "@agent-surface/testing/react";
import { matchers } from "@agent-surface/testing/matchers";
expect.extend(matchers);

it("exposes the documented surface", async () => {
  const s = await renderAgentSurface(<DevicesPage />);
  expect(s).toExpose("view:devices.table.selectRows");
  expect(s).toExposeUnavailable("domain:devices.disable", {
    reason: "Select at least one device first",
  });
  expect(s).toMatchSurfaceSnapshot(); // reviewable "what agents can see" artifact
});

it("runs the full disable flow", async () => {
  const s = await renderAgentSurface(<DevicesPage />);
  await s.invoke("view:devices.table.selectRows", { ids: ["d1"] });
  let r = await s.invoke("domain:devices.disable", {});
  expect(r).toFailWith("CONFIRMATION_REQUIRED");
  s.confirmations.approve();
  r = await s.invoke("domain:devices.disable", {}, {
    confirmationId: r.error.details!.confirmationId as string,
  });
  expect(r).toBeOk();
});
```

`createTestSurface` (framework-free) drives a bare registry the same way. Semantic snapshots normalize volatility (`registrationId` → `<reg#N>`), so they survive Strict Mode and remounts. Matchers distinguish *hidden* from *visible-disabled* — that distinction is the security model.

Full specification: [docs/08](https://github.com/Wiseair-srl/agent-surface/blob/main/docs/08-testing.md).

MIT © Wiseair S.r.l.
