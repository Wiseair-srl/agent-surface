# devices-app example

The [docs/10](../../docs/10-examples.md) devices page, end to end: status/city filters, a multi-select sortable table, a detail drawer, top-level navigation, a confirmation host, and a "Disable" flow backed by the mock authoritative backend through `domain:devices.disable` — bound to the live selection, locked, and gated by user confirmation.

This example is the acceptance artifact for the spec (docs/14 M10):

- [test/devices-app.test.tsx](test/devices-app.test.tsx) runs the full 11-step scenario **scripted, with no LLM**, plus the failure branches (denial, bait-and-switch, locked-field override, unmount mid-flow, staleness, ambiguity) and commits the semantic surface snapshot as a reviewable artifact.
- [src/agent/scripted-agent.ts](src/agent/scripted-agent.ts) is the fake "model": it lists tools, calls them, and follows the machine-actionable `retry` hints from [docs/07](../../docs/07-errors.md).

## Run it in a browser

```bash
pnpm --filter devices-app-example dev
```

The **agent console** (the dark panel — deliberately the machine's view against the human app) has two drivers over the same embedded toolset:

- **Scripted** — press *Run scripted scenario*: the fake model narrows the filters, reads the table, selects the visible offline Milano devices, and parks on the confirmation dialog until you approve — after which the mock server re-validates and disables them, and the table refetches. Deterministic; this is the CI path.
- **Live LLM** — paste an [OpenRouter](https://openrouter.ai) API key (or set `VITE_OPENROUTER_API_KEY` in `examples/devices-app/.env.local`), pick a model, and give it a task. A plain tool-calling loop feeds the model the live catalog per turn and executes its calls through the registry — confirmations, bound inputs, staleness and retry hints all apply identically. The key stays in your browser (optionally in localStorage) and is sent only to openrouter.ai. Never in CI.
