import { createElement, type ComponentType, type ReactElement, type ReactNode } from "react";
import { act, render, type RenderResult } from "@testing-library/react";
import { AgentSurfaceProvider } from "@agent-surface/react";
import { createTestSurface, type TestSurface, type TestSurfaceOptions } from "./harness.js";

export interface RenderAgentSurfaceOptions extends TestSurfaceOptions {
  wrapper?: ComponentType<{ children: ReactNode }>; // routers, query clients…
}

export interface RenderedAgentSurface extends TestSurface {
  /** RTL render result (rerender/unmount/container…). */
  view: RenderResult;
  rerender(ui: ReactElement): void;
  unmount(): void;
}

/**
 * Renders `ui` inside an AgentSurfaceProvider bound to a harness registry and
 * resolves after mount effects flush, so registrations are live (docs/08).
 * Runs fine under React Strict Mode — keep it on to prove cleanup symmetry.
 */
export async function renderAgentSurface(
  ui: ReactElement,
  options?: RenderAgentSurfaceOptions,
): Promise<RenderedAgentSurface> {
  const surface = createTestSurface(options);
  const Wrapper = options?.wrapper;

  const wrap = (element: ReactElement): ReactElement => {
    const provided = createElement(AgentSurfaceProvider, {
      registry: surface.registry,
      children: element,
    });
    return Wrapper ? createElement(Wrapper, null, provided) : provided;
  };

  let view!: RenderResult;
  await act(async () => {
    view = render(wrap(ui));
  });

  // Invocations run app handlers that call setState: wrap them in act() so
  // React commits deterministically and tests stay warning-free.
  const actInvoke: TestSurface["invoke"] = async (...args) => {
    let result!: Awaited<ReturnType<TestSurface["invoke"]>>;
    await act(async () => {
      result = await surface.invoke(...args);
    });
    return result;
  };

  return {
    ...surface,
    invoke: actInvoke,
    async observe(capabilityId, opts) {
      const versionBefore = surface.registry.getVersion();
      const result = await actInvoke(capabilityId, undefined, opts);
      if (result.status === "error") {
        throw new Error(
          `observe(${capabilityId}) failed: ${result.error.code} — ${result.error.message}`,
        );
      }
      if (surface.registry.getVersion() !== versionBefore) {
        throw new Error(
          `observe(${capabilityId}) mutated the surface; observations MUST be side-effect free (docs/01)`,
        );
      }
      return result.output as never;
    },
    confirmations: {
      pending: () => surface.confirmations.pending(),
      approve(confirmationId) {
        act(() => {
          surface.confirmations.approve(confirmationId);
        });
      },
      deny(confirmationId, reason) {
        act(() => {
          surface.confirmations.deny(confirmationId, reason);
        });
      },
      expire(confirmationId) {
        act(() => {
          surface.confirmations.expire(confirmationId);
        });
      },
    },
    view,
    rerender(next: ReactElement) {
      act(() => {
        view.rerender(wrap(next));
      });
    },
    unmount() {
      act(() => {
        view.unmount();
      });
    },
    dispose() {
      try {
        act(() => {
          view.unmount();
        });
      } catch {
        /* already unmounted */
      }
      surface.dispose();
    },
  };
}
