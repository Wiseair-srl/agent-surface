import { defineSurface } from "@agent-surface/cli";
import { createApp, type App as AppWiring } from "./src/agent/setup.js";
import { App } from "./src/app/App.js";

/**
 * One definition of "who is looking at this page", shared by three consumers:
 * `agent-surface inspect`, `agent-surface check` in CI, and the Vitest suite in
 * `test/devices-app.test.tsx`. Nothing here restates the app — `createApp` and
 * `<App>` are the same composition root `src/main.tsx` mounts.
 */
export default defineSurface({
  mount: ({ user }) => {
    const app = createApp({ environment: "test", user });
    return {
      registry: app.registry,
      // The agent console is the app's own UI for driving the surface; it is
      // not part of the surface, so the inspected tree leaves it out.
      ui: <App app={app} agentConsole={false} />,
      app,
    };
  },

  scenarios: {
    admin: { user: { id: "u_admin", permissions: ["devices:read", "devices:write"] } },
    // Authority hides (D11): signed out, the page offers an agent nothing at
    // all — `check` on this scenario is the regression test for that claim.
    anonymous: { user: null },
  },
});

export type DevicesApp = AppWiring;
