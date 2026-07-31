import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { ViteNodeServer } from "vite-node/server";
import { ViteNodeRunner } from "vite-node/client";
import { installSourcemapsSupport } from "vite-node/source-map";
import type { CollectOptions, CollectResult } from "./collect.js";
import type { SurfaceConfig } from "./config.js";

const CONFIG_NAMES = [
  "agent-surface.config.tsx",
  "agent-surface.config.ts",
  "agent-surface.config.mjs",
  "agent-surface.config.js",
];

/** Walks up from `from` looking for an `agent-surface.config.*`. */
export function findConfig(from: string = process.cwd()): string | undefined {
  let dir = resolve(from);
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** `dist/collect.js` when installed; `src/collect.ts` when run from source. */
function collectorPath(): string {
  for (const ext of ["js", "ts"]) {
    const candidate = fileURLToPath(new URL(`./collect.${ext}`, import.meta.url));
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("could not locate the agent-surface collector module");
}

export interface SurfaceRunner {
  config: SurfaceConfig;
  scenarioNames: string[];
  collect(options: CollectOptions): Promise<CollectResult>;
  close(): Promise<void>;
}

/**
 * Boots a Vite dev server on the app's own config, so the config file and the
 * app modules it imports are transformed and resolved exactly as the app
 * resolves them — its aliases, its plugins, its TSX.
 */
export async function createSurfaceRunner(configPath: string): Promise<SurfaceRunner> {
  const absoluteConfig = isAbsolute(configPath) ? configPath : resolve(configPath);
  if (!existsSync(absoluteConfig)) {
    throw new Error(`config not found: ${absoluteConfig}`);
  }
  const root = dirname(absoluteConfig);

  let server: ViteDevServer;
  try {
    server = await createServer({
      root,
      logLevel: "error",
      // `serve` so plugins behave as they do in dev; nothing is ever served.
      server: { middlewareMode: true, watch: null, fs: { strict: false } },
      optimizeDeps: { noDiscovery: true, include: [] },
      resolve: {
        // Both halves of the graph must agree on these. React because two
        // copies break hooks; core because `explainSurface` finds the registry
        // through a Symbol, which is per-module-instance (see collect.ts).
        dedupe: [
          "react",
          "react-dom",
          "@agent-surface/core",
          "@agent-surface/react",
          "@agent-surface/testing",
        ],
      },
    });
  } catch (error) {
    throw new Error(
      `could not start Vite for ${root}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    await server.pluginContainer.buildStart({});
  } catch {
    // Vite keeps moving this; a plugin that needs buildStart will say so itself.
  }

  const nodeServer = new ViteNodeServer(server);
  installSourcemapsSupport({ getSourceMap: (source) => nodeServer.getSourceMap(source) });

  const runner = new ViteNodeRunner({
    root: server.config.root,
    base: server.config.base,
    fetchModule: (id) => nodeServer.fetchModule(id),
    resolveId: (id, importer) => nodeServer.resolveId(id, importer),
  });

  const close = async (): Promise<void> => {
    await server.close();
  };

  try {
    const configModule = (await runner.executeFile(absoluteConfig)) as {
      default?: SurfaceConfig;
    };
    const config = configModule.default;
    if (!config || typeof config.mount !== "function") {
      throw new Error(
        `${absoluteConfig} must \`export default defineSurface({ mount, scenarios })\``,
      );
    }
    const scenarioNames = Object.keys(config.scenarios ?? {});
    if (scenarioNames.length === 0) {
      throw new Error(`${absoluteConfig} defines no scenarios`);
    }

    // Same runner ⇒ same module graph ⇒ the collector shares React and core
    // with the app tree it is about to mount.
    const collector = (await runner.executeFile(collectorPath())) as {
      collect(config: SurfaceConfig, options: CollectOptions): Promise<CollectResult>;
    };

    return {
      config,
      scenarioNames,
      collect: async (options) => {
        // Scoped to the mount, never process-wide: `act()` needs it, and Ink
        // renders its own React tree afterwards — with the flag still set,
        // every frame of the CLI's own UI prints React's "not wrapped in
        // act(...)" warning at the user.
        const globals = globalThis as Record<string, unknown>;
        const previous = globals["IS_REACT_ACT_ENVIRONMENT"];
        globals["IS_REACT_ACT_ENVIRONMENT"] = true;
        try {
          return await collector.collect(config, options);
        } finally {
          globals["IS_REACT_ACT_ENVIRONMENT"] = previous;
        }
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
