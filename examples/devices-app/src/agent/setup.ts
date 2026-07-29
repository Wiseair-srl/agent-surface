/**
 * App-level wiring (docs/10 §setup): one registry, one bridge, one executor.
 * Everything is a factory so tests get isolated instances.
 */
import { authenticated, createAgentSurfaceRegistry } from "@agent-surface/core";
import { createOrpcAgentBridge, type OrpcAgentManifest } from "@agent-surface/orpc";
import { z } from "zod";
import { createBackend, ServerError, type Session } from "../api/backend.js";
import type { PageT } from "../schemas.js";

const DisableInput = z.object({
  deviceIds: z.array(z.string()).min(1).describe("Ids of the devices to disable"),
  reason: z.string().optional().describe("Optional operator note"),
});
const DisableOutput = z.object({ disabled: z.number() });

/** Produced from the backend's orpc-agent configuration (docs/05, OQ-1). */
export const agentManifest: OrpcAgentManifest = {
  tools: {
    "devices.disable": {
      description: "Disable the given devices",
      inputSchema: z.toJSONSchema(DisableInput),
      outputSchema: z.toJSONSchema(DisableOutput),
      effect: "destructive",
    },
  },
};

export interface App {
  registry: ReturnType<typeof createAgentSurfaceRegistry>;
  bridge: ReturnType<typeof createOrpcAgentBridge<AppClient>>;
  backend: ReturnType<typeof createBackend>;
  session: Session;
  route: { current: PageT };
  /** The app's own query-invalidation bus (plain app concern, not library). */
  notifyDevicesChanged: () => void;
  onDevicesChanged: (listener: () => void) => () => void;
}

export interface AppClient {
  devices: {
    list: (
      input: { status?: "all" | "online" | "offline"; city?: string | null },
      options?: { context?: unknown },
    ) => Promise<{ items: Array<{ id: string; name: string; status: string; city: string }> }>;
    disable: (
      input: { deviceIds: string[]; reason?: string },
      options?: { context?: unknown },
    ) => Promise<{ disabled: number }>;
  };
}

export function createApp(options?: {
  environment?: "development" | "production" | "test";
  user?: Session["user"] | null;
}): App {
  const session: Session = {
    user:
      options?.user !== undefined
        ? options.user
        : { id: "u_operator", permissions: ["devices:read", "devices:write"] },
  };
  const backend = createBackend(session);
  const route: { current: PageT } = { current: "devices" };

  // The oRPC client: same authenticated transport the human user rides on.
  const client: AppClient = {
    devices: {
      list: (input, opts) => backend.list(input, opts?.context),
      disable: (input, opts) => backend.disable(input, opts?.context),
    },
  };

  const registry = createAgentSurfaceRegistry({
    environment: options?.environment ?? "production",
    context: () => ({ user: session.user }),
    policies: [authenticated()],
    route: () => ({ path: `/${route.current}` }),
  });

  const bridge = createOrpcAgentBridge({
    client,
    manifest: agentManifest,
    // Forward the invocation id + confirmation evidence as call context —
    // the server treats it as information, never authorization (docs/06 §7).
    callContext: (info) => ({
      agentInvocationId: info.invocationId,
      ...(info.confirmation ? { confirmation: info.confirmation } : {}),
    }),
    mapServerError: (error) =>
      error instanceof ServerError && error.code === "UNAUTHORIZED"
        ? {
            code: "NOT_AUTHORIZED",
            message: "The server rejected this call as not authorized.",
            retry: "no",
            details: { origin: "server" },
          }
        : undefined,
  });
  registry.setProcedureExecutor(bridge.executor);

  const devicesListeners = new Set<() => void>();
  const notifyDevicesChanged = (): void => {
    for (const listener of [...devicesListeners]) listener();
  };
  // Agent-driven mutations invalidate through the same bus as the UI's.
  registry.subscribe((event) => {
    if (
      event.type === "invocation-settled" &&
      event.capabilityId === "domain:devices.disable" &&
      event.status === "ok"
    ) {
      notifyDevicesChanged();
    }
  });

  return {
    registry,
    bridge,
    backend,
    session,
    route,
    notifyDevicesChanged,
    onDevicesChanged: (listener) => {
      devicesListeners.add(listener);
      return () => devicesListeners.delete(listener);
    },
  };
}
