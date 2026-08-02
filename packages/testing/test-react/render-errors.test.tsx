import { describe, expect, it } from "vitest";
import { renderAgentSurface } from "../src/react.js";

function BlankRenderFailure(): React.ReactElement {
  throw new Error();
}

function MaybeFailure(props: { fail: boolean }): React.ReactElement {
  if (props.fail) throw new Error("rerender failed");
  return <div />;
}

describe("render failure diagnostics", () => {
  it("preserves the component stack and replaces an empty message (#43)", async () => {
    const failure = await renderAgentSurface(<BlankRenderFailure />).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "Error thrown while rendering the scenario (no message)",
    );
    expect((failure as Error & { componentStack?: string }).componentStack).toContain(
      "BlankRenderFailure",
    );
    expect((failure as Error).cause).toBeInstanceOf(Error);
  });

  it("does not let the diagnostic boundary swallow a rerender failure", async () => {
    const surface = await renderAgentSurface(<MaybeFailure fail={false} />);
    expect(() => surface.rerender(<MaybeFailure fail />)).toThrow("rerender failed");
    surface.dispose();
  });
});
