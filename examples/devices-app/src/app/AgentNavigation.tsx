import { observation, action } from "@agent-surface/core";
import { useAgentComponent } from "@agent-surface/react";
import { GoToSchema, RouteStateSchema, type PageT } from "../schemas.js";

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
          disabled={props.page === page}
          onClick={() => props.onNavigate(page)}
        >
          {page}
        </button>
      ))}
    </nav>
  );
}
