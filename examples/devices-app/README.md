# devices-app example

The [docs/10](../../docs/10-examples.md) devices page, end to end: status/city filters, a multi-select sortable table, a detail drawer, top-level navigation, a confirmation host, and a "Disable" flow backed by the mock authoritative backend through `domain:devices.disable` — bound to the live selection, locked, and gated by user confirmation.

This example is the acceptance artifact for the spec (docs/14 M10):

- [test/devices-app.test.tsx](test/devices-app.test.tsx) runs the full 11-step scenario **scripted, with no LLM**, plus the failure branches (denial, bait-and-switch, locked-field override, unmount mid-flow, staleness, ambiguity) and commits the semantic surface snapshot as a reviewable artifact.
- [src/agent/scripted-agent.ts](src/agent/scripted-agent.ts) is the fake "model": it lists tools, calls them, and follows the machine-actionable `retry` hints from [docs/07](../../docs/07-errors.md).

## Run it in a browser

```bash
pnpm --filter devices-app-example dev
```

The **agent console** ([src/app/AgentConsole.tsx](src/app/AgentConsole.tsx)) floats over the page rather than taking a column out of the route: the app is the product, the console is an instrument pointed at it. The chat itself is [assistant-ui](https://www.assistant-ui.com): the console owns the messages and both run loops, so it exposes them through an **external-store runtime** rather than letting the library talk to a model. Every tool call becomes a first-class `tool-call` part of an assistant message, rendered by [ToolCall.tsx](src/app/ToolCall.tsx) — so the same row renders a call whether it came from the scripted agent or from a live model. The primitives are headless, so they wear the app's own CSS; there is no Tailwind here. It is a non-modal companion — no backdrop, no focus trap — so the surface stays visible and operable while an agent drives it, and it collapses to a launcher when you want the page to yourself. Opening or collapsing it never reflows the app: not one element moves or resizes, so what you see change underneath is the agent's doing and nothing else. It has two drivers over the same embedded toolset:

- **Scripted** — press *Run scenario*: the fake model narrows the filters, reads the table, selects the visible offline Milano devices, and parks on the confirmation dialog until you approve — after which the mock server re-validates and disables them, and the table refetches. Deterministic; this is the CI path.
- **Live LLM** — paste an [OpenRouter](https://openrouter.ai) API key (or set `VITE_OPENROUTER_API_KEY` in `examples/devices-app/.env.local`), pick a model, and give it a task. A plain tool-calling loop feeds the model the live catalog per turn and executes its calls through the registry — confirmations, bound inputs, staleness and retry hints all apply identically. The key stays in your browser (optionally in localStorage) and is sent only to openrouter.ai. Never in CI.

### Step by step

Tick **step by step** before running the scripted scenario and the agent parks before every call. The runner names the call the way the transcript does — plane chip plus capability id, never the raw wire name — and says what the plane means before you commit to it: a `view` call only moves what the page shows, a `domain` call is authoritative and will ask you to approve it. *Run step* advances one call (it takes focus, so <kbd>↵</kbd> works), *Run the rest* finishes without parking, *Stop* unwinds the scenario the same way a failed call would.

This is the fastest way to see the point of the whole library: each step changes the surface underneath, in the open, before the next one is allowed to happen. Collapse the console mid-run and the launcher keeps a *Run step* button, so you can advance the agent with the page completely unobstructed.
