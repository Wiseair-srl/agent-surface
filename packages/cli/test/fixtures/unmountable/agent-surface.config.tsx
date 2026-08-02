import { createAgentSurfaceRegistry } from "@agent-surface/core";
import { Panel } from "./Panel.js";

function BlankRenderFailure(): React.ReactElement {
  throw new Error();
}

/**
 * One scenario mounts, one throws. Before the command surface was merged,
 * `capabilities` was the only command that still worked on an app that would
 * not mount — so a merged command that let one bad scenario abort the run
 * would have thrown that property away.
 *
 * `defineSurface` is deliberately not imported: a fixture inside the package
 * cannot resolve the package by name, and the helper is an identity function.
 */
export default {
  mount: ({ boom, blankMount, blankRender }: {
    boom?: boolean;
    blankMount?: boolean;
    blankRender?: boolean;
  }) => {
    if (boom) throw new Error("the data layer needs a token this scenario cannot supply");
    if (blankMount) throw new Error();
    return {
      registry: createAgentSurfaceRegistry({ environment: "test" }),
      ui: blankRender ? <BlankRenderFailure /> : <Panel />,
    };
  },
  scenarios: {
    ok: { boom: false },
    broken: { boom: true },
    "blank-mount": { blankMount: true },
    "blank-render": { blankRender: true },
  },
};
