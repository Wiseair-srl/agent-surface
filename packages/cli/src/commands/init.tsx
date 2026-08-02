import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "../analysis.js";
import { authoredIds, extractCapabilities, findTsconfig } from "../extract.js";
import { isPlain, loadInk, writeError } from "../output.js";
import { createPresenter } from "../render/present.js";
import {
  catalogDetailParts,
  catalogRows,
  displayPath,
  READING_SOURCE,
  type ReportPart,
} from "../render/summary.js";

export interface InitOptions {
  cwd: string;
  tsconfig?: string;
  yes?: boolean;
  plain?: boolean;
}

const CONFIG_NAME = "agent-surface.config.tsx";

/**
 * Where an app is usually assembled. `init` does not *probe* these — it cannot,
 * because a surface config needs a `mount()` that builds the app, and there is
 * no export a tool can import to get one. It names the likeliest file so the
 * scaffold's import line points somewhere real more often than not.
 */
const ENTRY_CANDIDATES = [
  "src/main.tsx",
  "src/main.ts",
  "src/index.tsx",
  "src/App.tsx",
  "src/app/App.tsx",
  "app/root.tsx",
];

function scaffold(entry: string | undefined): string {
  const importPath = entry ? `./${entry.replace(/\.tsx?$/, ".js")}` : "./src/App.js";
  return `import { defineSurface } from "@agent-surface/cli";
// TODO: point these at your own composition root — whatever \`main.tsx\` calls.
// The config should *reuse* how the app builds itself, not restate it.
import { App } from "${importPath}";

export default defineSurface({
  mount: ({ user }) => {
    // TODO: build the app the way the app builds itself, and hand back the
    // registry it created plus the tree that registers into it.
    const app = createApp({ environment: "test", user });
    return { registry: app.registry, ui: <App app={app} />, app };
  },

  // Named prop bundles. Free-form — a user, a route, a feature flag; the CLI
  // never interprets them. Every scenario you leave out is a surface nothing
  // measures, which is what \`--depth full\` reports as unreached.
  scenarios: {
    default: { user: { id: "u_1", permissions: [] } },
  },
});
`;
}

/**
 * `agent-surface init` — the on-ramp.
 *
 * It reads the codebase first and writes nothing before it has shown you what
 * it found. That order is the whole point: the number it prints is the one
 * every later command is relative to, and a scaffold that appears before the
 * summary asks you to accept a config for a codebase neither of you has looked
 * at yet.
 *
 * It mounts nothing and needs no config to exist — it is `--depth static` with
 * a file write on the end, and it says so in the same blocks `inspect --depth
 * static` uses, so the first report a reader ever sees is the one they will go
 * on seeing.
 */
export async function runInit(options: InitOptions): Promise<number> {
  const configPath = join(options.cwd, CONFIG_NAME);
  if (existsSync(configPath)) {
    throw new UsageError(
      `${displayPath(configPath)} already exists — edit it, or delete it and re-run`,
    );
  }

  const tsconfig = options.tsconfig ?? findTsconfig(options.cwd);
  if (!tsconfig) {
    throw new UsageError(
      `no tsconfig.json found from ${options.cwd} — agent-surface reads your TypeScript program ` +
        "to find registration call sites, and cannot do that without one",
    );
  }

  const present = await createPresenter(options);
  await present.wait(READING_SOURCE);
  const inventory = extractCapabilities({ root: options.cwd, tsconfig });
  const ids = authoredIds(inventory);
  const entry = ENTRY_CANDIDATES.find((candidate) => existsSync(join(options.cwd, candidate)));

  const parts: ReportPart[] = [
    {
      kind: "blocks",
      blocks: [
        {
          title: "SURFACE INIT",
          rows: [
            { label: "Tsconfig", text: displayPath(tsconfig) },
            { label: "Config", text: `${displayPath(configPath)} — to be written` },
          ],
        },
        { title: "STATIC CATALOG", rows: catalogRows(inventory) },
      ],
    },
    ...(ids.size > 0 ? catalogDetailParts(inventory) : []),
  ];

  if (ids.size === 0) {
    parts.push({
      kind: "note",
      lines: [
        "Nothing is annotated yet — that is the default, and it is the safe one: a capability",
        "exists only where someone wrote one. Start with `useAgentComponent` in a component",
        "that owns state worth acting on, then re-run this.",
      ],
    });
  }

  parts.push({
    kind: "note",
    title: "SCAFFOLD",
    lines: [
      `  ${displayPath(configPath)}`,
      entry
        ? `  imports ./${entry}, which you will still have to wire into a mount()`
        : "  no app entry found, so the import line is a placeholder you will have to point somewhere",
    ],
  });
  await present.emit(...parts);

  if (!options.yes) {
    const answered = await ask(options, `Write ${CONFIG_NAME}?`);
    if (!answered) {
      await present.emit({ kind: "note", lines: ["Nothing written."] });
      return 0;
    }
  }

  writeFileSync(configPath, scaffold(entry), "utf8");
  await present.emit(
    { kind: "note", lines: [`wrote ${displayPath(configPath)}`] },
    {
      kind: "steps",
      title: "NEXT STEPS",
      steps: [
        "fill in mount() — it should call your existing composition root",
        "`agent-surface inspect` to see what an agent can reach",
        "`agent-surface snapshot` to commit the baseline, then `check` in CI",
      ],
    },
  );
  return 0;
}

/**
 * There is no prompt to give when nothing is attached to answer it. Failing
 * with the flag that would have worked beats writing a file the caller never
 * agreed to, and beats hanging on a read that will never return.
 */
async function ask(options: InitOptions, question: string): Promise<boolean> {
  if (isPlain(options) || process.stdin.isTTY !== true) {
    writeError("");
    writeError("stdin is not a terminal, so there is nobody to ask — re-run with --yes to accept.");
    return false;
  }
  const ink = await loadInk();
  if (!ink) {
    writeError("");
    writeError("no interactive renderer available here — re-run with --yes to accept.");
    return false;
  }
  const { render } = await import("ink");
  return new Promise<boolean>((resolve) => {
    const instance = render(
      <ink.Confirm
        question={question}
        onAnswer={(yes) => {
          instance.clear();
          instance.unmount();
          resolve(yes);
        }}
      />,
    );
  });
}
