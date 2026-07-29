import { useEffect, useState } from "react";
import { AgentSurfaceProvider } from "@agent-surface/react";
import type { App as AppWiring } from "../agent/setup.js";
import type { FiltersStateT, PageT } from "../schemas.js";
import { AgentConsole } from "./AgentConsole.js";
import { AgentNavigation } from "./AgentNavigation.js";
import { ConfirmationHost } from "./ConfirmationHost.js";
import { DeviceDrawer } from "./DeviceDrawer.js";
import { DeviceFilters } from "./DeviceFilters.js";
import { DevicesTable } from "./DevicesTable.js";

const PAGE_TITLES: Record<PageT, string> = {
  devices: "Devices",
  comparison: "Milano vs Roma",
  reports: "Reports",
};

function DevicesPage(props: { app: AppWiring }) {
  const [filters, setFilters] = useState<FiltersStateT>({ status: "all", city: null });
  const [drawerDeviceId, setDrawerDeviceId] = useState<string | null>(null);
  return (
    <>
      <DeviceFilters filters={filters} onChange={setFilters} />
      <DevicesTable
        app={props.app}
        filters={filters}
        onOpenDrawer={(id) => setDrawerDeviceId(id)}
      />
      <DeviceDrawer
        app={props.app}
        deviceId={drawerDeviceId}
        onOpen={(id) => setDrawerDeviceId(id)}
        onClose={() => setDrawerDeviceId(null)}
      />
    </>
  );
}

function ComparisonPage(props: { app: AppWiring }) {
  const [filtersMain, setFiltersMain] = useState<FiltersStateT>({ status: "all", city: "Milano" });
  const [filtersComparison, setFiltersComparison] = useState<FiltersStateT>({
    status: "all",
    city: "Roma",
  });
  return (
    <div className="compare">
      <div>
        <h3>Milano</h3>
        <DeviceFilters filters={filtersMain} onChange={setFiltersMain} instance="main" />
        <DevicesTable app={props.app} filters={filtersMain} instance="main" />
      </div>
      <div>
        <h3>Roma</h3>
        <DeviceFilters
          filters={filtersComparison}
          onChange={setFiltersComparison}
          instance="comparison"
        />
        <DevicesTable app={props.app} filters={filtersComparison} instance="comparison" />
      </div>
    </div>
  );
}

export function App(props: { app: AppWiring; agentConsole?: boolean }) {
  const [page, setPage] = useState<PageT>("devices");
  const showConsole = props.agentConsole !== false;

  // The registry's route() reads this ref (host wiring, docs/03).
  useEffect(() => {
    props.app.route.current = page;
  }, [props.app, page]);

  return (
    <AgentSurfaceProvider registry={props.app.registry}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">agent-surface</span>
          <span className="brand-title">Fleet</span>
        </div>
        <AgentNavigation page={page} onNavigate={setPage} />
        <span className="topbar-meta">example app · mock backend</span>
      </header>

      <div className="layout">
        <main>
          <div className="page-head">
            <h1 className="page-title">{PAGE_TITLES[page]}</h1>
            <span className="page-sub">
              every capability an agent can use here is explicitly registered
            </span>
          </div>
          {page === "devices" && <DevicesPage app={props.app} />}
          {page === "comparison" && <ComparisonPage app={props.app} />}
          {page === "reports" && (
            <div className="table-panel">
              <p className="empty-state" data-testid="reports-page">
                Reports coming soon — note the agent surface on this page is empty except
                navigation: nothing here is annotated, so nothing exists for the agent.
              </p>
            </div>
          )}
        </main>
      </div>

      {/* Floats over the app, deliberately: in step mode you watch the surface
          change underneath between calls. It never reflows the page. */}
      {showConsole && <AgentConsole app={props.app} />}
      <ConfirmationHost />
    </AgentSurfaceProvider>
  );
}
