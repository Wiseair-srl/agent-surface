#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runCheck, runInspect, runSnapshot, type CommandOptions } from "./commands.js";
import type { OutputFormat } from "./report.js";

const USAGE = `agent-surface — compiled production capability contract

Usage
  agent-surface inspect
  agent-surface snapshot
  agent-surface check --base origin/main --format github

Options
  --root <path>       application root (default: cwd)
  --config <path>     Vite config, relative to root
  --snapshot <path>   committed contract (default: .agent-surface/contract.json)
  --target <name>     production build target; repeatable
  --base <git-ref>    render committed PR drift against Git base
  --allow <pkg>=<d>   approve a dependency to contribute capabilities; repeatable
  --policy <mode>     all | widening | narrowing | neutral | none (default: all)
  --format <format>   human | json | github | markdown (default: human)
  --json              alias for --format json
  --plain             disable Ink terminal rendering
  -h, --help
  -v, --version

Exit: 0 clean/viewed, 1 deterministic drift/policy finding, 2 completeness failure.
`;

const COMMANDS = new Set(["inspect", "snapshot", "check"]);
const FORMATS = new Set<OutputFormat>(["human", "json", "github", "markdown"]);
const POLICIES = new Set(["all", "widening", "narrowing", "neutral", "none"]);

function write(text: string, error = false): void {
  (error ? process.stderr : process.stdout).write(text.endsWith("\n") ? text : `${text}\n`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        root: { type: "string", default: process.cwd() },
        config: { type: "string" },
        snapshot: { type: "string" },
        target: { type: "string", multiple: true },
        base: { type: "string" },
        allow: { type: "string", multiple: true },
        policy: { type: "string", default: "all" },
        format: { type: "string", default: "human" },
        json: { type: "boolean", default: false },
        plain: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (error) {
    write(error instanceof Error ? error.message : String(error), true);
    write(USAGE, true);
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
  const [command, ...extra] = positionals;
  if (!command || !COMMANDS.has(command) || extra.length > 0) {
    write(command === "init" ? "init removed: configure the Vite compiler plugin" : `invalid command ${command ?? ""}`, true);
    write(USAGE, true);
    return 2;
  }
  const format = (values.json ? "json" : values.format) as OutputFormat;
  if (!FORMATS.has(format)) {
    write(`--format must be human, json, github, or markdown`, true);
    return 2;
  }
  if (!POLICIES.has(values.policy)) {
    write(`--policy must be all, widening, narrowing, neutral, or none`, true);
    return 2;
  }
  const allow = [];
  for (const entry of values.allow ?? []) {
    const separator = entry.lastIndexOf("=");
    const name = separator === -1 ? "" : entry.slice(0, separator);
    const digest = separator === -1 ? "" : entry.slice(separator + 1);
    if (!name || !/^[0-9a-f]{64}$/.test(digest)) {
      write(`--allow must be <package>=<sha256>, got "${entry}"`, true);
      return 2;
    }
    allow.push({ package: name, digest });
  }
  const options: CommandOptions = {
    root: values.root,
    ...(values.config ? { configFile: values.config } : {}),
    ...(values.snapshot ? { snapshot: values.snapshot } : {}),
    targets: values.target ?? [],
    ...(values.base ? { base: values.base } : {}),
    format,
    policy: values.policy as CommandOptions["policy"],
    ...(allow.length > 0 ? { externalContracts: { allow } } : {}),
    ...(values.plain ? { plain: true } : {}),
  };
  try {
    if (command === "inspect") return await runInspect(options);
    if (command === "snapshot") return await runSnapshot(options);
    return await runCheck(options);
  } catch (error) {
    write(error instanceof Error ? error.message : String(error), true);
    if (error instanceof Error && error.stack && process.env["AGENT_SURFACE_DEBUG"]) {
      write(error.stack, true);
    }
    return 2;
  }
}

async function readVersion(): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const path = fileURLToPath(new URL("../package.json", import.meta.url));
  return (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;
}

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
  void main().then((code) => {
    process.exitCode = code;
  });
}
