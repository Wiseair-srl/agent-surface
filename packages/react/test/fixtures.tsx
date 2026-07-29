import { useState } from "react";
import { action, fromJsonSchema, observation, type JsonValue } from "@agent-surface/core";
import { useAgentComponent } from "@agent-surface/react";

export const TableStateSchema = fromJsonSchema<JsonValue>({
  type: "object",
  properties: {
    visibleRows: { type: "array", items: { type: "object", additionalProperties: true } },
    selectedIds: { type: "array", items: { type: "string" } },
  },
  required: ["visibleRows", "selectedIds"],
});

export const SelectRowsSchema = fromJsonSchema<{ ids: string[]; mode?: string }>({
  type: "object",
  properties: {
    ids: { type: "array", items: { type: "string" }, minItems: 1 },
    mode: { type: "string", enum: ["replace", "add", "remove"] },
  },
  required: ["ids"],
  additionalProperties: false,
});

export const ROWS = [
  { id: "d1", name: "Alpha", status: "offline", city: "Milano" },
  { id: "d2", name: "Beta", status: "offline", city: "Milano" },
];

export function DevicesTable(props: { instance?: string; onSelection?: (ids: string[]) => void }) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  useAgentComponent({
    type: "devices.table",
    ...(props.instance ? { instanceId: props.instance } : {}),
    description: "Table of devices matching the active filters",
    observations: {
      readState: observation({
        description: "Visible rows and current selection",
        output: TableStateSchema,
        read: () => ({ visibleRows: ROWS, selectedIds }),
      }),
    },
    actions: {
      selectRows: action({
        description: "Replace, extend or reduce the row selection",
        input: SelectRowsSchema,
        effect: "local-state",
        precondition: ({ ids }) => {
          const unknown = ids.filter((id) => !ROWS.some((r) => r.id === id));
          if (unknown.length > 0) return { message: "Unknown device ids", details: { unknown } };
        },
        execute: ({ ids, mode }) => {
          setSelectedIds((prev) => {
            const next =
              mode === "add"
                ? [...new Set([...prev, ...ids])]
                : mode === "remove"
                  ? prev.filter((id) => !ids.includes(id))
                  : ids;
            props.onSelection?.(next);
            return next;
          });
        },
      }),
      clearSelection: action({
        description: "Clear the selection",
        input: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }),
        effect: "local-state",
        when: () => selectedIds.length > 0,
        unavailableReason: "No rows are selected",
        execute: () => setSelectedIds([]),
      }),
    },
  });
  return <div data-testid="devices-table">{selectedIds.join(",")}</div>;
}
