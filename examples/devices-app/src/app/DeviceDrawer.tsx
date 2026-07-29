import { observation, action } from "@agent-surface/core";
import { useAgentComponent } from "@agent-surface/react";
import type { App } from "../agent/setup.js";
import { DrawerStateSchema, EmptyInputSchema, OpenDrawerSchema } from "../schemas.js";
import { X } from "./Icons.js";

export function DeviceDrawer(props: {
  app: App;
  deviceId: string | null;
  onOpen: (deviceId: string) => void;
  onClose: () => void;
}) {
  const { app, deviceId } = props;
  const isOpen = deviceId !== null;
  const device = isOpen ? app.backend.devices.find((d) => d.id === deviceId) : undefined;

  useAgentComponent({
    type: "devices.drawer",
    description: "Detail drawer for a single device",
    observations: {
      state: observation({
        description: "Whether the drawer is open and for which device",
        output: DrawerStateSchema,
        read: () => ({ isOpen, deviceId }),
      }),
    },
    actions: {
      open: action({
        description: "Open the detail drawer for a device",
        input: OpenDrawerSchema,
        effect: "local-state",
        precondition: (input) => {
          if (!app.backend.devices.some((d) => d.id === input.deviceId)) {
            return { message: "Unknown device id", details: { deviceId: input.deviceId } };
          }
        },
        execute: (input) => props.onOpen(input.deviceId),
      }),
      close: action({
        description: "Close the detail drawer",
        input: EmptyInputSchema,
        effect: "local-state",
        when: () => isOpen,
        unavailableReason: "The drawer is not open",
        execute: () => props.onClose(),
      }),
    },
  });

  if (!isOpen || !device) return null;
  return (
    <div className="drawer" data-testid="device-drawer">
      <dl>
        <div>
          <dt>Device</dt>
          <dd className="device-name">{device.name}</dd>
        </div>
        <div>
          <dt>Id</dt>
          <dd className="device-id">{device.id}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            <span className={`pill ${device.status}`}>{device.status}</span>
          </dd>
        </div>
        <div>
          <dt>City</dt>
          <dd>{device.city}</dd>
        </div>
      </dl>
      <button className="iconbtn" onClick={() => props.onClose()} aria-label="Close the details">
        <X size={14} />
      </button>
    </div>
  );
}
