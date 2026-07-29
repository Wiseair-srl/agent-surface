import { useEffect, useMemo, useRef, useState } from "react";
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
import { AlertTriangle, ChevronRight, Search, Sort } from "./Icons.js";

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

const ARIA_SORT = { asc: "ascending", desc: "descending" } as const;

/**
 * The app's own confirm for the human path. It deliberately does NOT look
 * like the agent's approval dialog: this one is red and says "you", because
 * you are the one doing it. Confirmation evidence is an agent protocol — a
 * person clicking a button in their own session has already expressed intent.
 */
function DisableDialog(props: { ids: string[]; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="scrim">
      <div
        className="dialog is-user"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="disable-title"
        tabIndex={-1}
        ref={ref}
        data-testid="human-confirm-dialog"
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onCancel();
        }}
      >
        <div className="dialog-head">
          <div className="dialog-kicker">
            <AlertTriangle size={13} />
            <span>Destructive</span>
          </div>
          <h2 className="dialog-title" id="disable-title">
            Disable {props.ids.length} device{props.ids.length === 1 ? "" : "s"}?
          </h2>
          <p className="dialog-summary">
            They stop reporting until someone re-enables them. The server re-validates the
            request either way.
          </p>
        </div>
        <pre className="payload">{props.ids.join("\n")}</pre>
        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={props.onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-danger"
            data-testid="human-confirm"
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            {props.busy ? "Disabling…" : "Disable"}
          </button>
        </div>
      </div>
    </div>
  );
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
  const [confirming, setConfirming] = useState(false);
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
    setBusy(true);
    try {
      await app.backend.disable({ deviceIds: selectedIds, reason: "operator-ui" });
      setSelectedIds([]);
      app.notifyDevicesChanged();
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  const header = (column: SortT["by"], label: string) => (
    <th
      scope="col"
      aria-sort={sorting.by === column ? ARIA_SORT[sorting.dir] : "none"}
    >
      <button type="button" className="th-label" onClick={() => toggleSort(column)}>
        {label}
        <Sort size={13} dir={sorting.by === column ? sorting.dir : null} />
      </button>
    </th>
  );

  return (
    <div className="panel">
      <table className="devices" data-testid={`devices-table-${props.instance ?? "default"}`}>
        <thead>
          <tr>
            <th scope="col" className="cell-check">
              <span className="th-label">
                <input
                  type="checkbox"
                  aria-label="Select all visible devices"
                  checked={allVisibleSelected}
                  onChange={() =>
                    setSelectedIds(allVisibleSelected ? [] : visibleRows.map((r) => r.id))
                  }
                />
              </span>
            </th>
            {header("name", "Name")}
            {header("status", "Status")}
            {header("city", "City")}
            <th scope="col" className="row-actions">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {visibleRows.length === 0 ? (
            <tr>
              <td colSpan={5}>
                <div className="empty-state">
                  <Search size={20} />
                  <span className="empty-title">No devices match the active filters</span>
                  <p className="empty-body">Widen the status or clear the city to see more.</p>
                </div>
              </td>
            </tr>
          ) : (
            visibleRows.map((row) => (
              <tr key={row.id} data-selected={selectedIds.includes(row.id)}>
                <td className="cell-check">
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
                <td className="row-actions">
                  <button
                    className="btn btn-soft btn-xs"
                    onClick={() => props.onOpenDrawer?.(row.id)}
                    aria-label={`Details for ${row.name}`}
                  >
                    Details
                    <ChevronRight size={12} />
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <div className={`table-foot${selectedIds.length > 0 ? " has-selection" : ""}`}>
        <span>
          {selectedIds.length > 0 ? (
            <>
              <strong>{selectedIds.length}</strong> of {visibleRows.length} selected
            </>
          ) : (
            <>
              {visibleRows.length} device{visibleRows.length === 1 ? "" : "s"}
            </>
          )}
        </span>
        {selectedIds.length > 0 && (
          <span className="foot-actions">
            <button className="btn btn-ghost btn-xs" onClick={() => setSelectedIds([])}>
              Clear
            </button>
            <button
              className="btn btn-danger btn-sm"
              data-testid="disable-selected"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              Disable {selectedIds.length}
            </button>
          </span>
        )}
      </div>

      {confirming && (
        <DisableDialog
          ids={selectedIds}
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void disableSelected()}
        />
      )}
    </div>
  );
}
