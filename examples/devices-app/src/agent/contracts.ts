import {
  actionContract,
  defineAgentComponentContract,
  defineAgentProcedureContract,
  fromJsonSchema,
  observationContract,
} from "@agent-surface/core";
import type {
  FiltersStateT,
  PageT,
  SortT,
  TableStateT,
} from "../schemas.js";

export const deviceFiltersContract = defineAgentComponentContract({
  type: "devices.filters",
  description: "Status and city filters applied to the devices table",
  observations: {
    read: observationContract({
      description: "Currently active filters",
      output: fromJsonSchema<FiltersStateT>({
        type: "object",
        properties: {
          status: { enum: ["all", "online", "offline"] },
          city: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        required: ["status", "city"],
        additionalProperties: false,
      }),
    }),
  },
  actions: {
    set: actionContract<Partial<FiltersStateT>>({
      description:
        "Update one or both filters; omitted fields are unchanged. The table refreshes through the app's normal data fetching.",
      input: fromJsonSchema<Partial<FiltersStateT>>({
        type: "object",
        properties: {
          status: { enum: ["all", "online", "offline"] },
          city: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        additionalProperties: false,
      }),
      effect: "local-state",
      idempotent: true,
    }),
  },
});

export const devicesTableContract = defineAgentComponentContract({
  type: "devices.table",
  description: "Table of devices matching the active filters",
  observations: {
    readState: observationContract({
      description: "Visible rows, current selection, current sorting",
      output: fromJsonSchema<TableStateT>({
        type: "object",
        properties: {
          visibleRows: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                status: { enum: ["online", "offline", "disabled"] },
                city: { type: "string" },
              },
              required: ["id", "name", "status", "city"],
              additionalProperties: false,
            },
          },
          selectedIds: { type: "array", items: { type: "string" } },
          sorting: {
            type: "object",
            properties: {
              by: { enum: ["name", "status", "city"] },
              dir: { enum: ["asc", "desc"] },
            },
            required: ["by", "dir"],
            additionalProperties: false,
          },
        },
        required: ["visibleRows", "selectedIds", "sorting"],
        additionalProperties: false,
      }),
    }),
  },
  actions: {
    selectRows: actionContract<{ ids: string[]; mode: "replace" | "add" | "remove" }>({
      description: "Replace, extend or reduce the row selection",
      input: fromJsonSchema({
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" }, minItems: 1 },
          mode: { enum: ["replace", "add", "remove"], default: "replace" },
        },
        required: ["ids"],
        additionalProperties: false,
      }),
      effect: "local-state",
    }),
    sort: actionContract<SortT>({
      description: "Change the table sorting",
      input: fromJsonSchema<SortT>({
        type: "object",
        properties: {
          by: { enum: ["name", "status", "city"] },
          dir: { enum: ["asc", "desc"] },
        },
        required: ["by", "dir"],
        additionalProperties: false,
      }),
      effect: "local-state",
      idempotent: true,
    }),
  },
});

export const deviceDrawerContract = defineAgentComponentContract({
  type: "devices.drawer",
  description: "Detail drawer for a single device",
  observations: {
    state: observationContract({
      description: "Whether the drawer is open and for which device",
      output: fromJsonSchema<{ isOpen: boolean; deviceId: string | null }>({
        type: "object",
        properties: {
          isOpen: { type: "boolean" },
          deviceId: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        required: ["isOpen", "deviceId"],
        additionalProperties: false,
      }),
    }),
  },
  actions: {
    open: actionContract<{ deviceId: string }>({
      description: "Open the detail drawer for a device",
      input: fromJsonSchema({
        type: "object",
        properties: { deviceId: { type: "string" } },
        required: ["deviceId"],
        additionalProperties: false,
      }),
      effect: "local-state",
    }),
    close: actionContract<Record<string, never>>({
      description: "Close the detail drawer",
      input: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }),
      effect: "local-state",
    }),
  },
});

export const navigationContract = defineAgentComponentContract({
  type: "app.navigation",
  description: "Top-level navigation between application pages",
  observations: {
    current: observationContract({
      description: "Current page",
      output: fromJsonSchema<{ page: PageT }>({
        type: "object",
        properties: { page: { enum: ["devices", "comparison", "reports"] } },
        required: ["page"],
        additionalProperties: false,
      }),
    }),
  },
  actions: {
    goTo: actionContract<{ page: PageT }>({
      description: "Navigate to a known application page",
      input: fromJsonSchema({
        type: "object",
        properties: { page: { enum: ["devices", "comparison", "reports"] } },
        required: ["page"],
        additionalProperties: false,
      }),
      effect: "navigation",
    }),
  },
});

export const devicesDisableContract = defineAgentProcedureContract({
  id: "domain:devices.disable",
  description: "Disable the given devices",
  input: fromJsonSchema<{ deviceIds: string[]; reason?: string }>({
    type: "object",
    properties: {
      deviceIds: { type: "array", items: { type: "string" }, minItems: 1 },
      reason: { type: "string" },
    },
    required: ["deviceIds"],
    additionalProperties: false,
  }),
  output: fromJsonSchema<{ disabled: number }>({
    type: "object",
    properties: { disabled: { type: "number" } },
    required: ["disabled"],
    additionalProperties: false,
  }),
  effect: "destructive",
  confirmation: "required",
});
