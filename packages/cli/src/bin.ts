#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEPTHS, isDepth } from "./contract.js";
import { installDom } from "./dom.js";
import { findConfig } from "./load.js";
import { writeError, write } from "./output.js";

const USAGE = `agent-surface — the agent surface your app exposes

Usage
  agent-surface init                     read the codebase, then scaffold a config
  agent-surface inspect    [scenario]    what an agent can reach, and what it cannot
  agent-surface snapshot   [scenario]    write/refresh the committed baseline
  agent-surface check      [scenario]    fail on drift, or on a capability no scenario reaches

Every command covers all scenarios in the config unless you name one.

Depth
  --depth full          read the source AND mount the scenarios, and report the gap (default)
  --depth static        read the source only — no Vite, no jsdom, no mount, no scenarios needed
  --depth runtime       mount only — skip the TypeScript program on a repo wide enough to feel it

Options
  --config <path>       path to agent-surface.config.* (default: nearest, searching upward)
  --baseline-dir        where baselines live (default: .agent-surface next to the config)
  --scope <prefix>      restrict to a component-type prefix (repeatable)
  --detail              one paragraph per capability instead of the table
  --explain             name the policies behind every decision (implies --detail)
  --schemas             include input/output JSON Schemas (implies --detail)
  --tsconfig <path>     tsconfig the source read uses (default: nearest to the config)
  --allow-unresolved    check: do not fail on a call site that could not be read
  --yes                 init: write without asking
  --json                emit data instead of a rendered view
  --plain               force plain text (implied when piped, or under CI / NO_COLOR)
  -h, --help            show this
  -v, --version         print the version

Exit codes are the contract: 0 clean, 1 a finding, 2 the command could not run.
`;

const COMMANDS = ["init", "inspect", "snapshot", "check"];

/** Commands that were cut, and where their answer went (0.11.0). */
const RETIRED: Record<string, string> = {
  capabilities: "agent-surface inspect --depth static",
  coverage: "agent-surface inspect (or `check`, which now fails on the gap)",
};

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
        depth: { type: "string", default: "full" },
        detail: { type: "boolean", default: false },
        explain: { type: "boolean", default: false },
        schemas: { type: "boolean", default: false },
        tsconfig: { type: "string" },
        "allow-unresolved": { type: "boolean", default: false },
        yes: { type: "boolean", default: false },
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
  if (!COMMANDS.includes(command)) {
    const moved = RETIRED[command];
    writeError(
      moved
        ? `"${command}" was removed in 0.11 — its answer is now \`${moved}\`. ` +
            "The static catalog and the live projection are one command, so the gap between " +
            "them is reported rather than left for whoever remembers to look."
        : `unknown command "${command}"`,
    );
    if (!moved) writeError(USAGE);
    return 2;
  }

  if (!isDepth(values.depth)) {
    writeError(`--depth must be one of ${DEPTHS.join(", ")} — got "${values.depth}"`);
    return 2;
  }
  const depth = values.depth;

  try {
    if (command === "init") {
      // Nothing to find and nothing to mount: `init` is the command that runs
      // before a config exists.
      const { runInit } = await import("./commands/init.js");
      return await runInit({
        cwd: process.cwd(),
        ...(values.tsconfig ? { tsconfig: values.tsconfig } : {}),
        ...(values.yes ? { yes: true } : {}),
        ...(values.plain ? { plain: true } : {}),
      });
    }

    const configPath = values.config ?? findConfig();
    if (!configPath) {
      writeError(
        "no agent-surface.config.* found (searched upward from the working directory).\n" +
          "Run `agent-surface init`, or see https://agent-surface-docs.vercel.app/20-cli",
      );
      return 2;
    }

    // A presentation surface needs a DOM to mount into, and react-dom reads
    // these globals at import time — so this must happen before any app module
    // loads. It stays installed for the life of the process, on purpose
    // (see dom.ts).
    //
    // `--depth static` is the exception, and deliberately so: it reads the
    // TypeScript program and mounts nothing, so it must not pay for — or be
    // able to be affected by — a DOM it never renders into.
    if (depth !== "static") installDom();

    const shared = {
      configPath,
      depth,
      ...(scenario ? { scenario } : {}),
      ...(values.scope ? { scope: values.scope } : {}),
      ...(values.tsconfig ? { tsconfig: values.tsconfig } : {}),
      ...(values.json ? { json: true } : {}),
      ...(values.plain ? { plain: true } : {}),
      ...(values["baseline-dir"] ? { baselineDir: values["baseline-dir"] } : {}),
    };

    if (command === "inspect") {
      const { runInspect } = await import("./commands/inspect.js");
      return await runInspect({
        ...shared,
        ...(values.detail ? { detail: true } : {}),
        ...(values.explain ? { explain: true } : {}),
        ...(values.schemas ? { schemas: true } : {}),
      });
    }
    if (command === "snapshot") {
      const { runSnapshot } = await import("./commands/snapshot.js");
      return await runSnapshot(shared);
    }
    const { runCheck } = await import("./commands/check.js");
    return await runCheck({
      ...shared,
      ...(values["allow-unresolved"] ? { allowUnresolved: true } : {}),
    });
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack && process.env["AGENT_SURFACE_DEBUG"]) {
      writeError(error.stack);
    }
    // `2` — the command could not run, as opposed to running and finding
    // something. CI has to tell those apart: a gate that exits 1 both when the
    // surface changed and when the tool never loaded the app is a gate whose
    // green is the only signal worth anything, and whose red says nothing.
    return 2;
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

/**
 * How long a finished command is allowed to keep running before it is treated
 * as wedged. Costs a hung run one extra second; costs a healthy run nothing,
 * because a healthy run has already exited by then.
 */
const GRACE_MS = 1000;

/**
 * What this process's own stdin/stdout/stderr are called, depending on where
 * they were pointed: a terminal, a `|`, or a `>`. None of the three holds the
 * event loop open — a clean run exits naturally through all of them — so when
 * something *else* has wedged the command they are still in the handle table,
 * and naming them would send the reader after the one thing that is not the
 * cause. Their own leak would be the CLI's bug to fix, not the app's to hear
 * about.
 */
const OWN_STDIO = new Set(["TTYWrap", "PipeWrap", "FileWrap"]);

/** Resource types still holding the loop once the command is provably wedged. */
function heldHandles(): string[] {
  const active = process.getActiveResourcesInfo?.() ?? [];
  return active.filter((resource) => !OWN_STDIO.has(resource));
}

/**
 * `process.exit()` discards whatever is still buffered on a pipe, so a
 * redirected run could lose its last lines — and redirected runs are the ones
 * that matter (`--json`, CI logs). Drain both streams first, but never wait
 * indefinitely: a reader that has stopped consuming must not turn a forced exit
 * back into the hang it exists to prevent.
 */
async function flushOutput(): Promise<void> {
  const drained = Promise.all(
    [process.stdout, process.stderr].map(
      (stream) =>
        new Promise<void>((resolve) => {
          if (stream.writableLength === 0) resolve();
          else stream.write("", () => resolve());
        }),
    ),
  );
  const deadline = new Promise<void>((resolve) => {
    setTimeout(resolve, 2000).unref();
  });
  await Promise.race([drained, deadline]);
}

/**
 * Ends the process, and says why it had to be ended when that is the case.
 *
 * The mount is an arbitrary React tree, not code written for a one-shot
 * process: a polling interval, a websocket, an animation loop or a data layer's
 * cache timer all keep Node's event loop alive long after the surface has been
 * rendered. Setting `process.exitCode` alone means such a command prints its
 * full, correct output and then appears to hang — with a successful exit code
 * already set, and nothing on screen to explain the wait (`AS-CLI-005`).
 *
 * The detector is the timer itself, not a reading of the handle table. An
 * unref'd timer does not hold the loop open, so a command with nothing left to
 * do exits naturally on `process.exitCode` and this never fires. Its firing is
 * therefore the diagnosis — this run *was* about to hang — and whatever it then
 * finds in the handle table is genuinely the cause. Reading the table eagerly
 * instead would blame the app for the CLI's own teardown: vite's dev server is
 * still closing its socket at the moment the last scenario is rendered, so
 * every healthy run would accuse its own app of leaking a `TCPServerWrap`.
 *
 * Naming the handles is the same move the package already makes for
 * capabilities: the invisible thing becomes inspectable. Exiting anyway is what
 * makes the tool usable unattended.
 */
function exitWhenWedged(code: number): void {
  process.exitCode = code;
  setTimeout(() => {
    const held = heldHandles();
    if (held.length > 0) {
      const kinds = [...new Set(held)].sort().join(", ");
      writeError(
        `agent-surface: the output above is complete, but ${held.length} handle(s) are still ` +
          `open (${kinds}) — something started during the mount is still running, so this ` +
          `command would have waited instead of exiting. Common causes: a polling interval, a ` +
          `websocket, or a data layer whose cache timer outlives the render. Exiting ${code}.`,
      );
    }
    void flushOutput().then(() => process.exit(code));
  }, GRACE_MS).unref();
}

if (invokedAsBinary()) {
  main().then(
    (code) => exitWhenWedged(code),
    (error: unknown) => {
      writeError(error instanceof Error ? error.message : String(error));
      exitWhenWedged(1);
    },
  );
}
