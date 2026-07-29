import { useEffect, useMemo, useState } from "react";
import { observation, action } from "@agent-surface/core";
import { useAgentComponent } from "@agent-surface/react";
import { useAgentProcedure } from "@agent-surface/orpc/react";
import type { App } from "../agent/setup.js";
import {
  SelectRowsSchema,
  SortSchema,
  TableStateSchema,
  type FiltersStateT,
  type SortT,
  type TableStateT,
} from "../schemas.js";

type Row = TableStateT["visibleRows"][number];

/** Normal app data fetching: refetches when filters change or after a
 *  successful domain mutation (query invalidation via registry events). */
function useDevicesQuery(app: App, filters: FiltersStateT): Row[] {
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    let alive = true;
    const refetch = (): void => {
      void app.backend
        .list({ status: filters.status, city: filters.city })
        .then((r) => {
          if (alive) setRows(r.items as Row[]);
        })
        .catch(() => {
          if (alive) setRows([]);
        });
    };
    refetch();
    const unsubscribe = app.registry.subscribe((event) => {
      if (
        event.type === "invocation-settled" &&
        event.capabilityId === "domain:devices.disable" &&
        event.status === "ok"
      ) {
        refetch();
      }
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [app, filters.status, filters.city]);
  return rows;
}

function sortIndicator(sorting: SortT, column: SortT["by"]): string {
  if (sorting.by !== column) return "";
  return sorting.dir === "asc" ? " ↑" : " ↓";
}

export function DevicesTable(props: {
  app: App;
  filters: FiltersStateT;
  instance?: string;
  onOpenDrawer?: (deviceId: string) => void;
}) {
  const { app, filters } = props;
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sorting, setSorting] = useState<SortT>({ by: "name", dir: "asc" });
  const [busy, setBusy] = useState(false);
  const rows = useDevicesQuery(app, filters);

  const visibleRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      const av = a[sorting.by];
      const bv = b[sorting.by];
      return sorting.dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    });
  }, [rows, sorting]);

  useAgentComponent({
    type: "devices.table",
    ...(props.instance ? { instanceId: props.instance } : {}),
    description: "Table of devices matching the active filters",
    observations: {
      readState: observation({
        description: "Visible rows, current selection, current sorting",
        output: TableStateSchema,
        read: () => ({ visibleRows, selectedIds, sorting }),
      }),
    },
    actions: {
      selectRows: action({
        description: "Replace, extend or reduce the row selection",
        input: SelectRowsSchema,
        effect: "local-state",
        precondition: ({ ids }) => {
          const unknown = ids.filter((id) => !visibleRows.some((r) => r.id === id));
          if (unknown.length > 0) {
            return { message: "Some ids are not in the current result set", details: { unknown } };
          }
        },
        execute: ({ ids, mode }) => {
          setSelectedIds((prev) =>
            mode === "add"
              ? [...new Set([...prev, ...ids])]
              : mode === "remove"
                ? prev.filter((id) => !ids.includes(id))
                : ids,
          );
        },
      }),
      sort: action({
        description: "Change the table sorting",
        input: SortSchema,
        effect: "local-state",
        idempotent: true,
        execute: (next) => setSorting(next),
      }),
    },
  });

  useAgentProcedure(app.bridge.refs.devices.disable, {
    when: () => selectedIds.length > 0,
    unavailableReason: "Select at least one device first",
    bind: () => ({ deviceIds: selectedIds }),
    confirmation: "required",
    describe: () => `Currently bound to the ${selectedIds.length} selected device(s).`,
  });

  const toggle = (id: string): void => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const toggleSort = (column: SortT["by"]): void => {
    setSorting((prev) =>
      prev.by === column
        ? { by: column, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { by: column, dir: "asc" },
    );
  };

  const allVisibleSelected =
    visibleRows.length > 0 && visibleRows.every((r) => selectedIds.includes(r.id));

  /**
   * The HUMAN path for the same domain operation: the app calls its own oRPC
   * client directly. Confirmation evidence is an AGENT protocol — a user who
   * clicks a button in their own session has already expressed intent (the
   * app shows its own confirm). Either way the server re-validates.
   */
  const disableSelected = async (): Promise<void> => {
    if (selectedIds.length === 0 || busy) return;
    const ok = globalThis.confirm?.(
      `Disable ${selectedIds.length} device(s)?\n\n${selectedIds.join(", ")}`,
    );
    if (ok === false) return;
    setBusy(true);
    try {
      await app.backend.disable({ deviceIds: selectedIds, reason: "operator-ui" });
      setSelectedIds([]);
      app.notifyDevicesChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="table-panel">
      <table className="devices" data-testid={`devices-table-${props.instance ?? "default"}`}>
        <thead>
          <tr>
            <th style={{ width: 34 }}>
              <input
                type="checkbox"
                aria-label="Select all visible devices"
                checked={allVisibleSelected}
                onChange={() =>
                  setSelectedIds(allVisibleSelected ? [] : visibleRows.map((r) => r.id))
                }
              />
            </th>
            <th onClick={() => toggleSort("name")} style={{ cursor: "pointer" }}>
              Name{sortIndicator(sorting, "name")}
            </th>
            <th onClick={() => toggleSort("status")} style={{ cursor: "pointer" }}>
              Status{sortIndicator(sorting, "status")}
            </th>
            <th onClick={() => toggleSort("city")} style={{ cursor: "pointer" }}>
              City{sortIndicator(sorting, "city")}
            </th>
            <th style={{ width: 70 }}></th>
          </tr>
        </thead>
        <tbody>
          {visibleRows.length === 0 ? (
            <tr>
              <td colSpan={5}>
                <div className="empty-state">No devices match the active filters.</div>
              </td>
            </tr>
          ) : (
            visibleRows.map((row) => (
              <tr key={row.id} data-selected={selectedIds.includes(row.id)}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.name}`}
                    checked={selectedIds.includes(row.id)}
                    onChange={() => toggle(row.id)}
                  />
                </td>
                <td>
                  <div className="device-name">{row.name}</div>
                  <div className="device-id">{row.id}</div>
                </td>
                <td data-testid={`status-${row.id}`}>
                  <span className={`pill ${row.status}`}>{row.status}</span>
                </td>
                <td>{row.city}</td>
                <td>
                  <button className="rowbtn" onClick={() => props.onOpenDrawer?.(row.id)}>
                    details
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <div className="table-foot">
        <span>
          {visibleRows.length} device{visibleRows.length === 1 ? "" : "s"}
        </span>
        <span className="table-foot-actions">
          <span>{selectedIds.length > 0 ? `${selectedIds.length} selected` : "none selected"}</span>
          {selectedIds.length > 0 && (
            <>
              <button className="rowbtn" onClick={() => setSelectedIds([])}>
                clear
              </button>
              <button
                className="btn-danger"
                data-testid="disable-selected"
                disabled={busy}
                onClick={() => void disableSelected()}
              >
                {busy ? "Disabling…" : `Disable ${selectedIds.length}`}
              </button>
            </>
          )}
        </span>
      </div>
    </div>
  );
}
