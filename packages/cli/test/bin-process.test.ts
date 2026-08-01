/**
 * Conformance: AS-CLI-004 (stdout carries the command's output and nothing
 * else, so `--json` parses), AS-CLI-005 (the command exits even when the
 * mounted app leaves the event loop busy).
 *
 * These spawn the real binary rather than calling `main()`. Both guarantees are
 * about the *process* — which stream a write lands on, and whether Node's loop
 * ever drains — and neither is observable from inside a Vitest worker that has
 * already patched the streams and owns the loop.
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const HOSTILE = fileURLToPath(new URL("./fixtures/hostile/agent-surface.config.tsx", import.meta.url));
const CLEAN = fileURLToPath(
  new URL("../../../examples/devices-app/agent-surface.config.tsx", import.meta.url),
);

const TIMEOUT = 120_000;
/** Far below the fixture's five-minute timer: only a real exit finishes in this. */
const KILL_AFTER = 60_000;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  killed: boolean;
}

function run(args: string[]): Promise<Run> {
  if (!existsSync(BIN)) {
    throw new Error(`${BIN} not found — these tests exercise the built binary; run \`pnpm build\``);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const kill = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, KILL_AFTER);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(kill);
      resolve({ code, stdout, stderr, killed });
    });
  });
}

describe("AS-CLI-004 — stdout carries command output only", () => {
  it(
    "--json parses even when the app's registry is in development mode",
    async () => {
      const { code, stdout, stderr, killed } = await run([
        "inspect",
        "default",
        "--config",
        HOSTILE,
        "--json",
      ]);

      expect(killed).toBe(false);
      expect(code).toBe(0);

      // The whole point: no diagnostic line may precede or interleave with it.
      const data = JSON.parse(stdout) as { scenarios: Array<{ scenario: string }> };
      expect(data.scenarios.map((entry) => entry.scenario)).toEqual(["default"]);

      // Moved, not silenced — the development audit trail is still emitted.
      expect(stderr).toContain("[agent-surface audit]");
      expect(stdout).not.toContain("[agent-surface audit]");
    },
    TIMEOUT,
  );
});

describe("AS-CLI-005 — the command exits when the app leaves handles open", () => {
  it(
    "exits, and names what was still running",
    async () => {
      const { code, stdout, stderr, killed } = await run([
        "inspect",
        "default",
        "--config",
        HOSTILE,
        "--plain",
      ]);

      // Without the forced exit this waits out the fixture's five-minute timer.
      expect(killed).toBe(false);
      expect(code).toBe(0);
      // Output is complete, not truncated by the exit.
      expect(stdout).toContain("hostile.panel");
      expect(stderr).toContain("handle(s) are still open");
      expect(stderr).toContain("Timeout");
    },
    TIMEOUT,
  );

  it(
    "says nothing when the app leaves nothing behind",
    async () => {
      const { code, stderr, killed } = await run(["inspect", "admin", "--config", CLEAN, "--plain"]);

      expect(killed).toBe(false);
      expect(code).toBe(0);
      // A tidy app must never be accused of a leak — in particular not of the
      // CLI's own vite server, which is still closing its socket at this point.
      expect(stderr).not.toContain("handle(s) are still open");
    },
    TIMEOUT,
  );
});
