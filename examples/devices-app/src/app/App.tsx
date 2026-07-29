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
import { Layers } from "./Icons.js";

const PAGES: Record<PageT, { title: string; sub: React.ReactNode }> = {
  devices: {
    title: "Devices",
    sub: (
      <>
        Filters, a sortable multi-select table, a detail drawer, and one authoritative{" "}
        <code>domain:devices.disable</code>. Every capability an agent can use here was
        explicitly registered — open the console's surface readout to see the list.
      </>
    ),
  },
  comparison: {
    title: "Milano vs Roma",
    sub: (
      <>
        The same two components mounted twice. Instances are disambiguated by id, so an agent
        has to say which table it means: <code>…_at_main</code> or <code>…_at_comparison</code>.
      </>
    ),
  },
  reports: {
    title: "Reports",
    sub: "Nothing on this page is annotated, so the agent surface here is empty except navigation.",
  },
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
      <section>
        <div className="compare-head">
          <h2>Milano</h2>
          <span className="u-kicker">instance main</span>
        </div>
        <DeviceFilters filters={filtersMain} onChange={setFiltersMain} instance="main" />
        <DevicesTable app={props.app} filters={filtersMain} instance="main" />
      </section>
      <section>
        <div className="compare-head">
          <h2>Roma</h2>
          <span className="u-kicker">instance comparison</span>
        </div>
        <DeviceFilters
          filters={filtersComparison}
          onChange={setFiltersComparison}
          instance="comparison"
        />
        <DevicesTable app={props.app} filters={filtersComparison} instance="comparison" />
      </section>
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
        <span className="topbar-meta">
          mock backend
          {showConsole && (
            <>
              <span aria-hidden="true">·</span>
              <span>
                console <kbd className="kbd">⌘I</kbd>
              </span>
            </>
          )}
        </span>
      </header>

      <div className="layout">
        <main>
          <div className="page-head">
            <h1 className="page-title">{PAGES[page].title}</h1>
            <p className="page-sub">{PAGES[page].sub}</p>
          </div>
          {page === "devices" && <DevicesPage app={props.app} />}
          {page === "comparison" && <ComparisonPage app={props.app} />}
          {page === "reports" && (
            <div className="panel">
              <div className="empty-state" data-testid="reports-page">
                <Layers size={20} />
                <span className="empty-title">No agent surface on this page</span>
                <p className="empty-body">
                  Reports are coming later. Nothing here is annotated, so nothing here exists for
                  an agent — which is the default, not an oversight.
                </p>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Floats over the app, deliberately: in step mode you watch the surface
          change underneath between calls. The layout reserves its footprint
          permanently, so it neither reflows the page nor covers it. */}
      {showConsole && <AgentConsole app={props.app} />}
      <ConfirmationHost />
    </AgentSurfaceProvider>
  );
}
