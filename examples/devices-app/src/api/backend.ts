/**
 * Mock AUTHORITATIVE backend — stands in for oRPC procedures governed by
 * orpc-agent. It re-validates session, input, and ids on every call,
 * regardless of anything the frontend did (docs/05 D10): the frontend is
 * never a security boundary.
 */

export interface Device {
  id: string;
  name: string;
  status: "online" | "offline" | "disabled";
  city: string;
}

export interface Session {
  user: { id: string; permissions: string[] } | null;
}

export interface BackendCall {
  path: string;
  input: unknown;
  context: unknown;
}

const SEED: Device[] = [
  { id: "dev_1", name: "Duomo Nord", status: "offline", city: "Milano" },
  { id: "dev_2", name: "Navigli Est", status: "offline", city: "Milano" },
  { id: "dev_3", name: "Porta Romana", status: "offline", city: "Milano" },
  { id: "dev_4", name: "Isola Hub", status: "online", city: "Milano" },
  { id: "dev_5", name: "Trastevere", status: "online", city: "Roma" },
  { id: "dev_6", name: "Testaccio", status: "offline", city: "Roma" },
];

export class ServerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function createBackend(session: Session) {
  const devices: Device[] = SEED.map((d) => ({ ...d }));
  const calls: BackendCall[] = [];

  const requireSession = (): void => {
    if (!session.user) throw new ServerError("UNAUTHORIZED", "no session");
  };

  return {
    devices,
    calls,
    async list(
      input: { status?: "all" | "online" | "offline"; city?: string | null },
      context?: unknown,
    ): Promise<{ items: Device[] }> {
      calls.push({ path: "devices.list", input, context });
      requireSession();
      const status = input.status ?? "all";
      const items = devices.filter(
        (d) =>
          (status === "all" || d.status === status) &&
          (input.city == null || d.city === input.city),
      );
      return { items: items.map((d) => ({ ...d })) };
    },
    async disable(
      input: { deviceIds: string[]; reason?: string },
      context?: unknown,
    ): Promise<{ disabled: number }> {
      calls.push({ path: "devices.disable", input, context });
      // The server re-checks EVERYTHING: session, shape, id existence.
      requireSession();
      if (!session.user!.permissions.includes("devices:write")) {
        throw new ServerError("UNAUTHORIZED", "missing devices:write");
      }
      if (!Array.isArray(input.deviceIds) || input.deviceIds.length === 0) {
        throw new ServerError("BAD_REQUEST", "deviceIds must be a non-empty array");
      }
      for (const id of input.deviceIds) {
        if (!devices.some((d) => d.id === id)) {
          throw new ServerError("BAD_REQUEST", `unknown device ${id}`);
        }
      }
      let disabled = 0;
      for (const device of devices) {
        if (input.deviceIds.includes(device.id) && device.status !== "disabled") {
          device.status = "disabled";
          disabled += 1;
        }
      }
      return { disabled };
    },
  };
}

export type Backend = ReturnType<typeof createBackend>;
