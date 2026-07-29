import { observation, action } from "@agent-surface/core";
import { useAgentComponent } from "@agent-surface/react";
import { FiltersPatchSchema, FiltersStateSchema, type FiltersStateT } from "../schemas.js";
import { Select } from "./Select.js";

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "online", label: "Online" },
  { value: "offline", label: "Offline" },
] as const;

/** One agent component for the whole filter bar — granularity follows intent. */
export function DeviceFilters(props: {
  filters: FiltersStateT;
  onChange: (next: FiltersStateT) => void;
  /** Distinguishes simultaneous mounts (comparison page) — data-derived. */
  instance?: string;
}) {
  const { filters, onChange } = props;

  useAgentComponent({
    type: "devices.filters",
    ...(props.instance ? { instanceId: props.instance } : {}),
    description: "Status and city filters applied to the devices table",
    observations: {
      read: observation({
        description: "Currently active filters",
        output: FiltersStateSchema,
        read: () => filters,
      }),
    },
    actions: {
      set: action({
        description:
          "Update one or both filters; omitted fields are unchanged. " +
          "The table refreshes through the app's normal data fetching.",
        input: FiltersPatchSchema,
        effect: "local-state",
        idempotent: true,
        execute: (patch) => onChange({ ...filters, ...patch }),
      }),
    },
  });

  return (
    <div className="filters">
      <Select
        value={filters.status}
        options={STATUS_OPTIONS}
        label="Status filter"
        testId="filter-status"
        onChange={(status) => onChange({ ...filters, status })}
      />
      <input
        className="control"
        data-testid="filter-city"
        aria-label="City filter"
        value={filters.city ?? ""}
        placeholder="All cities"
        onChange={(e) => onChange({ ...filters, city: e.target.value || null })}
      />
      {(filters.status !== "all" || filters.city) && (
        <button
          className="rowbtn"
          data-testid="clear-filters"
          onClick={() => onChange({ status: "all", city: null })}
        >
          clear
        </button>
      )}
    </div>
  );
}
