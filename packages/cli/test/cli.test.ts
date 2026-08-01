// Conformance: AS-CLI-002 (check's exit codes are the contract),
// AS-CLI-003 (piped / --plain / CI / NO_COLOR output is plain and stable).
//
// These drive the real `main()` against the real example app — vite-node, a
// real mount, a real snapshot. Anything less would not prove the exit code.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/bin.js";

const CONFIG = fileURLToPath(
  new URL("../../../examples/devices-app/agent-surface.config.tsx", import.meta.url),
);

const TIMEOUT = 120_000;

let baselineDir: string;
let captured: string[];
let restore: (() => void) | undefined;

function capture(): void {
  captured = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  restore = () => {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  };
}

function output(): string {
  return captured.join("");
}

beforeEach(() => {
  baselineDir = mkdtempSync(join(tmpdir(), "agent-surface-cli-"));
  capture();
});

afterEach(() => {
  restore?.();
  restore = undefined;
  rmSync(baselineDir, { recursive: true, force: true });
});

describe("check exit codes (AS-CLI-002)", () => {
  it(
    "exits 1 when no baseline exists, and says how to create one",
    async () => {
      const code = await main(["check", "--config", CONFIG, "--baseline-dir", baselineDir]);
      expect(code).toBe(1);
      expect(output()).toContain("agent-surface snapshot");
    },
    TIMEOUT,
  );

  it(
    "exits 0 against a baseline it just wrote, and 1 once the surface drifts",
    async () => {
      expect(
        await main(["snapshot", "--config", CONFIG, "--baseline-dir", baselineDir]),
      ).toBe(0);
      expect(await main(["check", "--config", CONFIG, "--baseline-dir", baselineDir])).toBe(0);

      // Tamper with the recorded surface the way a code change would: the
      // description a model reads is part of the contract (D28).
      const path = join(baselineDir, "admin.json");
      const baseline = JSON.parse(readFileSync(path, "utf8")) as {
        components: Array<{ actions: Array<{ description: string; capabilityId: string }> }>;
      };
      const action = baseline.components.flatMap((c) => c.actions)[0]!;
      action.description = `${action.description} (edited)`;
      writeFileSync(path, JSON.stringify(baseline, null, 2));

      captured = [];
      expect(await main(["check", "--config", CONFIG, "--baseline-dir", baselineDir])).toBe(1);
      // The drift is reported against the capability, not a JSON path alone.
      expect(output()).toContain(action.capabilityId);
      expect(output()).toContain("(edited)");
    },
    TIMEOUT,
  );

  it(
    "exits 2 on usage errors without mounting anything",
    async () => {
      expect(await main(["nonsense", "--config", CONFIG])).toBe(2);
      expect(output()).toContain('unknown command "nonsense"');
    },
    TIMEOUT,
  );

  it(
    "exits 1 with a named scenario that does not exist",
    async () => {
      const code = await main(["inspect", "nope", "--config", CONFIG, "--plain"]);
      expect(code).toBe(1);
      expect(output()).toContain('unknown scenario "nope"');
    },
    TIMEOUT,
  );
});

describe("plain output (AS-CLI-003)", () => {
  it(
    "emits no ANSI escapes and is byte-stable across runs",
    async () => {
      expect(await main(["inspect", "admin", "--config", CONFIG, "--plain"])).toBe(0);
      const first = output();

      captured = [];
      expect(await main(["inspect", "admin", "--config", CONFIG, "--plain"])).toBe(0);
      const second = output();

      // eslint-disable-next-line no-control-regex
      expect(first).not.toMatch(/\[/);
      expect(first).toBe(second);
      expect(first).toContain("view:devices.table.readState".split(".").pop());
    },
    TIMEOUT,
  );

  it(
    "renders plain when stdout is not a TTY, without being asked",
    async () => {
      // Vitest already runs with a non-TTY stdout, so this is the piped case.
      expect(process.stdout.isTTY).not.toBe(true);
      expect(await main(["inspect", "admin", "--config", CONFIG])).toBe(0);
      const piped = output();

      captured = [];
      await main(["inspect", "admin", "--config", CONFIG, "--plain"]);
      expect(piped).toBe(output());
    },
    TIMEOUT,
  );

  it("no command module imports the Ink renderer statically", async () => {
    // Ink drives React through react-reconciler, which reads React 19
    // internals: a top-level import makes it unloadable on a React 18 host and
    // takes the plain-text path down with it — a path that was never going to
    // draw a terminal UI in the first place. It must stay behind loadInk().
    const { readFileSync } = await import("node:fs");
    for (const file of ["inspect.tsx", "check.tsx", "snapshot.ts"]) {
      const source = readFileSync(
        fileURLToPath(new URL(`../src/commands/${file}`, import.meta.url)),
        "utf8",
      );
      expect(source, `${file} must reach Ink through loadInk()`).not.toMatch(
        /^import\s[^;]*from\s+["'][^"']*render\/ink/m,
      );
    }
  });

  it(
    "--json emits parseable data, and only carries the explanation when asked",
    async () => {
      expect(await main(["inspect", "admin", "--config", CONFIG, "--json"])).toBe(0);
      // One shape whether or not a scenario was named, so a consumer never has
      // to branch on how the command was invoked.
      const plain = JSON.parse(output()) as { scenarios: Array<Record<string, unknown>> };
      expect(plain.scenarios).toHaveLength(1);
      expect(plain.scenarios[0]?.["scenario"]).toBe("admin");
      expect(plain.scenarios[0]).not.toHaveProperty("explanation");

      captured = [];
      await main(["inspect", "anonymous", "--config", CONFIG, "--json", "--explain"]);
      const explained = (
        JSON.parse(output()) as {
          scenarios: Array<{
            snapshot: { components: unknown[] };
            explanation: {
              capabilities: Array<{ outcome: string; policies: Array<{ name: string }> }>;
            };
          }>;
        }
      ).scenarios[0]!;
      // Authority hides: nothing in the snapshot, everything in the explanation.
      expect(explained.snapshot.components).toHaveLength(0);
      expect(explained.explanation.capabilities.length).toBeGreaterThan(0);
      expect(
        explained.explanation.capabilities.every((c) => c.outcome === "hide"),
      ).toBe(true);
      expect(
        explained.explanation.capabilities[0]?.policies.map((p) => p.name),
      ).toContain("authenticated");
    },
    TIMEOUT,
  );
});

describe("inspect covers every scenario by default", () => {
  it(
    "renders all of them, in config order, and one alone when named",
    async () => {
      expect(await main(["inspect", "--config", CONFIG, "--plain"])).toBe(0);
      const all = output();
      expect(all).toContain("scenario admin");
      expect(all).toContain("scenario anonymous");
      // Config order, not alphabetical — the config lists admin first.
      expect(all.indexOf("scenario admin")).toBeLessThan(all.indexOf("scenario anonymous"));
      // Signed out, the page offers an agent nothing: the second block is the
      // empty surface, not a repeat of the first (D11).
      expect(all).toContain("the agent has no surface here");

      captured = [];
      expect(await main(["inspect", "admin", "--config", CONFIG, "--plain"])).toBe(0);
      const one = output();
      expect(one).toContain("scenario admin");
      expect(one).not.toContain("scenario anonymous");
    },
    TIMEOUT,
  );

  it(
    "--json carries one entry per scenario",
    async () => {
      expect(await main(["inspect", "--config", CONFIG, "--json"])).toBe(0);
      const data = JSON.parse(output()) as {
        scenarios: Array<{ scenario: string; snapshot: { components: unknown[] } }>;
      };
      expect(data.scenarios.map((entry) => entry.scenario)).toEqual(["admin", "anonymous"]);
      expect(data.scenarios[0]?.snapshot.components.length).toBeGreaterThan(0);
      expect(data.scenarios[1]?.snapshot.components).toHaveLength(0);
    },
    TIMEOUT,
  );
});
