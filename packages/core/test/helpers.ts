import {
  action,
  defineAgentComponent,
  fromJsonSchema,
  observation,
  type AgentComponentDefinition,
  type AgentProcedureBinding,
  type JsonValue,
} from "@agent-surface/core";

export interface DevicesState {
  selectedIds: string[];
  sorting: { by: string; dir: string };
  rows: Array<{ id: string; name: string; status: string; city: string }>;
}

export const TableStateSchema = fromJsonSchema<JsonValue>({
  type: "object",
  properties: {
    visibleRows: { type: "array", items: { type: "object", additionalProperties: true } },
    selectedIds: { type: "array", items: { type: "string" } },
    sorting: { type: "object", additionalProperties: true },
  },
  required: ["visibleRows", "selectedIds", "sorting"],
});

export const SelectRowsSchema = fromJsonSchema<{ ids: string[]; mode?: "replace" | "add" | "remove" }>({
  type: "object",
  properties: {
    ids: { type: "array", items: { type: "string" }, minItems: 1 },
    mode: { type: "string", enum: ["replace", "add", "remove"] },
  },
  required: ["ids"],
  additionalProperties: false,
});

export function makeDevicesState(): DevicesState {
  return {
    selectedIds: [],
    sorting: { by: "name", dir: "asc" },
    rows: [
      { id: "d1", name: "Alpha", status: "offline", city: "Milano" },
      { id: "d2", name: "Beta", status: "offline", city: "Milano" },
      { id: "d3", name: "Gamma", status: "online", city: "Roma" },
    ],
  };
}

export function devicesTableDefinition(
  state: DevicesState,
  overrides?: Partial<AgentComponentDefinition>,
): AgentComponentDefinition {
  return defineAgentComponent({
    type: "devices.table",
    description: "Table of devices matching the active filters",
    observations: {
      readState: observation({
        description: "Visible rows, current selection, current sorting",
        output: TableStateSchema,
        read: () => ({
          visibleRows: state.rows,
          selectedIds: state.selectedIds,
          sorting: state.sorting,
        }),
      }),
    },
    actions: {
      selectRows: action({
        description: "Replace, extend or reduce the row selection",
        input: SelectRowsSchema,
        effect: "local-state",
        precondition: ({ ids }) => {
          const unknown = ids.filter((id) => !state.rows.some((r) => r.id === id));
          if (unknown.length > 0) {
            return { message: "Some ids are not in the current result set", details: { unknown } };
          }
        },
        execute: ({ ids, mode }) => {
          if (mode === "add") state.selectedIds = [...new Set([...state.selectedIds, ...ids])];
          else if (mode === "remove")
            state.selectedIds = state.selectedIds.filter((id) => !ids.includes(id));
          else state.selectedIds = ids;
        },
      }),
      clearSelection: action({
        description: "Clear the current selection",
        input: fromJsonSchema<Record<string, never>>({
          type: "object",
          properties: {},
          additionalProperties: false,
        }),
        effect: "local-state",
        when: () => state.selectedIds.length > 0,
        unavailableReason: "No rows are selected",
        execute: () => {
          state.selectedIds = [];
        },
      }),
    },
    ...overrides,
  });
}

export const DisableInputSchema = {
  type: "object",
  properties: {
    deviceIds: { type: "array", items: { type: "string" }, minItems: 1 },
    reason: { type: "string" },
  },
  required: ["deviceIds"],
  additionalProperties: false,
};

export function disableBinding(
  state: DevicesState,
  opts?: {
    overridableFields?: string[];
    noBind?: boolean;
    bind?: () => Record<string, JsonValue>;
    when?: () => boolean;
    effect?: "server-query" | "server-mutation" | "external-side-effect" | "destructive";
    describe?: () => string;
  },
): AgentProcedureBinding {
  const overridable = new Set(opts?.overridableFields ?? []);
  const boundKeys = opts?.noBind ? [] : ["deviceIds"];
  const lockedKeys = boundKeys.filter((k) => !overridable.has(k));
  const properties: Record<string, unknown> = {
    ...(lockedKeys.includes("deviceIds")
      ? {}
      : { deviceIds: DisableInputSchema.properties.deviceIds }),
    reason: DisableInputSchema.properties.reason,
  };
  const required = lockedKeys.includes("deviceIds") ? [] : boundKeys.includes("deviceIds") ? [] : ["deviceIds"];
  return {
    kind: "procedure-binding",
    ref: {
      id: "domain:devices.disable",
      path: "devices.disable",
      description: "Disable the given devices",
      inputSchema: DisableInputSchema,
      outputSchema: {
        type: "object",
        properties: { disabled: { type: "number" } },
        required: ["disabled"],
      },
      effect: opts?.effect ?? "destructive",
    },
    config: {
      when: opts?.when ?? (() => state.selectedIds.length > 0),
      unavailableReason: "Select at least one device first",
      ...(opts?.noBind
        ? {}
        : { bind: opts?.bind ?? (() => ({ deviceIds: state.selectedIds })) }),
      ...(opts?.overridableFields ? { overridableFields: opts.overridableFields } : {}),
      ...(opts?.describe ? { describe: opts.describe } : {}),
    },
    boundKeys,
    lockedKeys,
    reducedInputSchema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
  };
}
