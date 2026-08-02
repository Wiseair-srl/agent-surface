import {
  Component,
  createElement,
  type ComponentType,
  type ErrorInfo,
  type ReactElement,
  type ReactNode,
} from "react";
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

interface CapturedRenderFailure {
  error: unknown;
  componentStack?: string;
}

interface ReactCaughtErrorInfo {
  componentStack?: string | null;
}

interface RenderFailureBoundaryProps {
  children: ReactNode;
  onError(error: unknown, componentStack?: string): void;
}

class RenderFailureBoundary extends Component<
  RenderFailureBoundaryProps,
  { failed: boolean }
> {
  public state = { failed: false };

  public static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  public componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.onError(error, info.componentStack?.trim() || undefined);
  }

  public render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

class CapturedRenderError extends Error {
  public readonly componentStack?: string;

  public constructor(failure: CapturedRenderFailure) {
    const original = failure.error instanceof Error ? failure.error : undefined;
    const name = original?.name.trim() || original?.constructor.name || "Error";
    const message =
      original?.message.trim() || `${name} thrown while rendering the scenario (no message)`;
    super(message, { cause: failure.error });
    this.name = name;
    if (original?.stack?.trim()) this.stack = original.stack;
    if (failure.componentStack) this.componentStack = failure.componentStack;
  }
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
  let failure: CapturedRenderFailure | undefined;

  const capture = (error: unknown, componentStack?: string | null): void => {
    const stack = componentStack?.trim() || undefined;
    if (!failure) failure = { error, ...(stack ? { componentStack: stack } : {}) };
    else if (!failure.componentStack && stack) failure.componentStack = stack;
  };
  const throwCaptured = (): void => {
    if (failure) throw new CapturedRenderError(failure);
  };

  const wrap = (element: ReactElement): ReactElement => {
    const provided = createElement(AgentSurfaceProvider, {
      registry: surface.registry,
      children: element,
    });
    const wrapped = Wrapper ? createElement(Wrapper, null, provided) : provided;
    return createElement(RenderFailureBoundary, {
      onError: capture,
      children: wrapped,
    });
  };

  let view: RenderResult | undefined;
  try {
    await act(async () => {
      view = render(wrap(ui), {
        // React 19 calls this with the same original error and component stack
        // the boundary sees. Supplying it also prevents React's default stderr
        // dump; React 18 ignores the unknown root option and uses componentDidCatch.
        onCaughtError: (error: unknown, info: ReactCaughtErrorInfo) =>
          capture(error, info.componentStack),
      } as unknown as Parameters<typeof render>[1]);
    });
    // React can defer passive-effect failures until the next act turn. Keep
    // that turn inside the boundary's capture window rather than returning a
    // surface that throws an anonymous replacement from its caller (#43).
    await act(async () => {});
  } catch (error) {
    if (!failure) failure = { error };
  }

  if (failure || !view) {
    if (view) {
      act(() => {
        view?.unmount();
      });
    }
    surface.dispose();
    throw new CapturedRenderError(
      failure ?? { error: new Error("React returned no mounted view for the scenario") },
    );
  }
  const mountedView = view;

  // Invocations run app handlers that call setState: wrap them in act() so
  // React commits deterministically and tests stay warning-free.
  const actInvoke: TestSurface["invoke"] = async (...args) => {
    let result!: Awaited<ReturnType<TestSurface["invoke"]>>;
    await act(async () => {
      result = await surface.invoke(...args);
    });
    throwCaptured();
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
        throwCaptured();
      },
      deny(confirmationId, reason) {
        act(() => {
          surface.confirmations.deny(confirmationId, reason);
        });
        throwCaptured();
      },
      expire(confirmationId) {
        act(() => {
          surface.confirmations.expire(confirmationId);
        });
        throwCaptured();
      },
    },
    view: mountedView,
    rerender(next: ReactElement) {
      act(() => {
        mountedView.rerender(wrap(next));
      });
      throwCaptured();
    },
    unmount() {
      act(() => {
        mountedView.unmount();
      });
    },
    dispose() {
      try {
        act(() => {
          mountedView.unmount();
        });
      } catch {
        /* already unmounted */
      }
      surface.dispose();
    },
  };
}
