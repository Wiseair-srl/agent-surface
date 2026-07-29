import { observation, action } from "@agent-surface/core";
import { useAgentComponent } from "@agent-surface/react";
import { GoToSchema, RouteStateSchema, type PageT } from "../schemas.js";

const LABELS: Record<PageT, string> = {
  devices: "Devices",
  comparison: "Comparison",
  reports: "Reports",
};

/** The router stays the app's; navigation is just another capability.
 *  Enum-of-known-pages beats free-form paths (docs/10). */
export function AgentNavigation(props: { page: PageT; onNavigate: (page: PageT) => void }) {
  useAgentComponent({
    type: "app.navigation",
    description: "Top-level navigation between application pages",
    observations: {
      current: observation({
        description: "Current page",
        output: RouteStateSchema,
        read: () => ({ page: props.page }),
      }),
    },
    actions: {
      goTo: action({
        description: "Navigate to a known application page",
        input: GoToSchema,
        effect: "navigation",
        execute: ({ page }) => props.onNavigate(page),
      }),
    },
  });

  return (
    <nav className="nav" aria-label="Pages">
      {(["devices", "comparison", "reports"] as const).map((page) => (
        <button
          key={page}
          data-testid={`nav-${page}`}
          // aria-current, not disabled: the current page stays focusable, so
          // keyboard users can still tab across the whole nav.
          aria-current={props.page === page ? "page" : undefined}
          onClick={() => props.onNavigate(page)}
        >
          {LABELS[page]}
        </button>
      ))}
    </nav>
  );
}
