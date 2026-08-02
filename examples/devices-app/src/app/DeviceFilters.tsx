import { useAgentComponent } from "@agent-surface/react";
import type { FiltersStateT } from "../schemas.js";
import { deviceFiltersContract } from "../agent/contracts.js";
import { Search, X } from "./Icons.js";
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
  const dirty = filters.status !== "all" || Boolean(filters.city);

  useAgentComponent(deviceFiltersContract, {
    ...(props.instance ? { instanceId: props.instance } : {}),
    observations: {
      read: {
        read: () => filters,
      },
    },
    actions: {
      set: {
        execute: (patch) => onChange({ ...filters, ...patch }),
      },
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
      <label className="field">
        <Search size={13} />
        <input
          data-testid="filter-city"
          aria-label="City filter"
          value={filters.city ?? ""}
          placeholder="All cities"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onChange({ ...filters, city: e.target.value || null })}
        />
      </label>
      {dirty && (
        <button
          className="btn btn-ghost"
          data-testid="clear-filters"
          onClick={() => onChange({ status: "all", city: null })}
        >
          <X size={12} />
          Clear
        </button>
      )}
    </div>
  );
}
