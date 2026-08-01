import { createAgentSurfaceRegistry, action, fromJsonSchema } from "@agent-surface/core";

/**
 * The two things a real application does that the CLI has to survive, in the
 * smallest form that still does them. Drives AS-CLI-004 and AS-CLI-005.
 *
 * 1. **`environment: "development"`.** Not an exotic choice — it is what a Vite
 *    app gets from `import.meta.env.PROD ? "production" : "development"`, since
 *    that flag is `false` under vite-node. It selects core's default console
 *    audit leg, which used to write every registration to stdout.
 *
 * 2. **A timer nobody clears.** The shape a polling interval or a data layer's
 *    cache timeout leaves behind — five minutes is TanStack Query's default
 *    `gcTime`, which is where this was first seen. Nothing here is unusual; the
 *    point is that the app is not required to be tidy for the command to end.
 *
 * `defineSurface` is deliberately not imported: a fixture inside the package
 * cannot resolve the package by name, and the helper is an identity function
 * whose only job is inference.
 */
export default {
  mount: () => {
    const registry = createAgentSurfaceRegistry({ environment: "development" });
    registry.register({
      type: "hostile.panel",
      description: "a panel that exists so the surface is not empty",
      actions: {
        ping: action({
          description: "does nothing, observably",
          input: fromJsonSchema<Record<string, never>>({
            type: "object",
            properties: {},
            additionalProperties: false,
          }),
          effect: "local-state" as const,
          execute: () => ({ ok: true }),
        }),
      },
    });

    setTimeout(() => {}, 5 * 60 * 1000);

    return { registry, ui: <div /> };
  },
  scenarios: { default: {} },
};
