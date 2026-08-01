#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { installDom } from "./dom.js";
import { findConfig } from "./load.js";
import { writeError, write } from "./output.js";

const USAGE = `agent-surface — inspect and check the agent surface your app exposes

Usage
  agent-surface inspect  [scenario]   what an agent can see right now
  agent-surface snapshot [scenario]   write/refresh the committed baseline
  agent-surface check    [scenario]   fail if the surface drifted from the baseline

Every command covers all scenarios in the config unless you name one.

Options
  --config <path>   path to agent-surface.config.* (default: nearest, searching upward)
  --baseline-dir    where baselines live (default: .agent-surface next to the config)
  --scope <prefix>  restrict to a component-type prefix (repeatable)
  --explain         name the policies behind every decision, hidden ones included
  --schemas         include input/output JSON Schemas
  --json            emit data instead of a rendered view
  --plain           force plain text (implied when piped, or under CI / NO_COLOR)
  -h, --help        show this
  -v, --version     print the version
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: "string" },
        "baseline-dir": { type: "string" },
        scope: { type: "string", multiple: true },
        explain: { type: "boolean", default: false },
        schemas: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        plain: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error));
    writeError(USAGE);
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    write(USAGE);
    return 0;
  }
  if (values.version) {
    write(await readVersion());
    return 0;
  }

  const [command, scenario] = positionals;
  if (!command) {
    write(USAGE);
    return 2;
  }
  if (!["inspect", "snapshot", "check"].includes(command)) {
    writeError(`unknown command "${command}"`);
    writeError(USAGE);
    return 2;
  }

  const configPath = values.config ?? findConfig();
  if (!configPath) {
    writeError(
      "no agent-surface.config.* found (searched upward from the working directory).\n" +
        "Create one that points at your app's composition root — see https://agent-surface-docs.vercel.app/20-cli",
    );
    return 2;
  }

  // A presentation surface needs a DOM to mount into, and react-dom reads these
  // globals at import time — so this must happen before any app module loads.
  const uninstallDom = installDom();
  try {
    const shared = {
      configPath,
      ...(scenario ? { scenario } : {}),
      ...(values.scope ? { scope: values.scope } : {}),
      ...(values.json ? { json: true } : {}),
      ...(values.plain ? { plain: true } : {}),
      ...(values["baseline-dir"] ? { baselineDir: values["baseline-dir"] } : {}),
    };

    if (command === "inspect") {
      const { runInspect } = await import("./commands/inspect.js");
      return await runInspect({
        ...shared,
        ...(values.explain ? { explain: true } : {}),
        ...(values.schemas ? { schemas: true } : {}),
      });
    }
    if (command === "snapshot") {
      const { runSnapshot } = await import("./commands/snapshot.js");
      return await runSnapshot(shared);
    }
    const { runCheck } = await import("./commands/check.js");
    return await runCheck(shared);
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack && process.env["AGENT_SURFACE_DEBUG"]) {
      writeError(error.stack);
    }
    return 1;
  } finally {
    uninstallDom();
  }
}

async function readVersion(): Promise<string> {
  try {
    const { readFileSync } = await import("node:fs");
    const path = fileURLToPath(new URL("../package.json", import.meta.url));
    return (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

/**
 * Self-execute only as a binary; importing this module (tests) must not run it.
 * `argv[1]` is compared through `realpathSync` because package managers install
 * the bin as a symlink — comparing the raw path silently never matches, and the
 * CLI exits 0 having done nothing.
 */
function invokedAsBinary(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (invokedAsBinary()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      writeError(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
