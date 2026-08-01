// Conformance: AS-CLI-002 (the exit-code contract), AS-CLI-003 (piped /
// --plain / CI / NO_COLOR output is plain and stable), AS-CLI-006 (rejected
// registrations are reported), AS-CLI-007 (counts carry their qualifier),
// AS-CLI-008 (--depth selects which halves are computed), AS-CLI-009 (stable
// complete report), AS-CLI-010 (baseline/scenario integrity).
//
// These drive the real `main()` against the real example app — vite-node, a
// real mount, a real snapshot. Anything less would not prove the exit code.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/bin.js";
import { baselinePath } from "../src/baseline.js";

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
      // "No baseline" is not drift. Filing it under a heading that says the
      // surface changed would be a claim about a comparison that never ran.
      expect(output()).toContain("NO BASELINE");
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
      expect(output()).toContain("DRIFT");
      expect(output()).toContain(action.capabilityId);
      expect(output()).toContain("(edited)");
    },
    TIMEOUT,
  );

  it(
    "exits 2 when a baseline exists but cannot be parsed",
    async () => {
      await main(["snapshot", "--config", CONFIG, "--baseline-dir", baselineDir]);
      writeFileSync(join(baselineDir, "admin.json"), "{ broken");
      captured = [];
      expect(await main(["check", "--config", CONFIG, "--baseline-dir", baselineDir])).toBe(2);
      expect(output()).toContain("could not read baseline");
    },
    TIMEOUT,
  );

  it(
    "fails when scenario manifest or baseline files are stale",
    async () => {
      await main(["snapshot", "--config", CONFIG, "--baseline-dir", baselineDir]);
      writeFileSync(join(baselineDir, "retired.json"), "{}\n");
      captured = [];
      expect(await main(["check", "--config", CONFIG, "--baseline-dir", baselineDir])).toBe(1);
      expect(output()).toContain("SCENARIO DRIFT");
      expect(output()).toContain("retired");
    },
    TIMEOUT,
  );

  it("rejects scenario names that could escape or collide in baselineDir", () => {
    expect(() => baselinePath(baselineDir, "../escape")).toThrow("invalid scenario name");
    expect(() => baselinePath(baselineDir, "scenarios")).toThrow("invalid scenario name");
  });

  it(
    "exits 2 on usage errors without mounting anything",
    async () => {
      expect(await main(["nonsense", "--config", CONFIG])).toBe(2);
      expect(output()).toContain('unknown command "nonsense"');
    },
    TIMEOUT,
  );

  it(
    "exits 2 — not 1 — when it could not run at all",
    async () => {
      // `1` means the command ran and found something; `2` means it never ran.
      // A gate that answers 1 to both is a gate whose red says nothing, and CI
      // cannot tell "the surface changed" from "the tool never loaded the app".
      expect(await main(["inspect", "nope", "--config", CONFIG, "--plain"])).toBe(2);
      expect(output()).toContain('unknown scenario "nope"');

      captured = [];
      expect(await main(["inspect", "--config", "/nonexistent/agent-surface.config.tsx"])).toBe(2);

      captured = [];
      expect(await main(["inspect", "--config", CONFIG, "--depth", "sideways"])).toBe(2);
      expect(output()).toContain("--depth must be one of");
    },
    TIMEOUT,
  );

  it(
    "names where a retired command's answer went, rather than only refusing it",
    async () => {
      // Cut clean in 0.11 — no aliases. An error that only says "unknown" makes
      // the reader search the changelog for a command whose answer still exists.
      expect(await main(["capabilities", "--config", CONFIG])).toBe(2);
      expect(output()).toContain("inspect --depth static");

      captured = [];
      expect(await main(["coverage", "--config", CONFIG])).toBe(2);
      expect(output()).toContain("check");
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
    for (const file of ["inspect.tsx", "check.ts", "snapshot.ts", "init.tsx"]) {
      const source = readFileSync(
        fileURLToPath(new URL(`../src/commands/${file}`, import.meta.url)),
        "utf8",
      );
      expect(source, `${file} must reach Ink through loadInk()`).not.toMatch(
        /^import\s[^;]*from\s+["'][^"']*render\/ink/m,
      );
    }
  });

  it("check has no rendering framework in its path at all", async () => {
    // Its output is a report pasted into a pull request and read out of a CI
    // log, and neither of those is a terminal. It does not even reach for Ink
    // behind loadInk() — it is plain, always, with no branch to get wrong.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      fileURLToPath(new URL("../src/commands/check.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/loadInk|\bink\b/);
  });

  it(
    "--json emits parseable data, and only carries the explanation when asked",
    async () => {
      expect(await main(["inspect", "admin", "--config", CONFIG, "--json"])).toBe(0);
      // One shape whatever the depth and whether or not a scenario was named,
      // so a consumer never branches on how the command was invoked. A half the
      // depth did not compute is `null`, which is a different statement from
      // `[]` or `{}`.
      const plain = JSON.parse(output()) as {
        depth: string;
        catalog: { capabilities: unknown[] } | null;
        scenarios: Array<Record<string, unknown>>;
        coverage: { unreached: unknown[] } | null;
        failures: unknown[];
      };
      expect(plain.depth).toBe("full");
      expect(plain.scenarios).toHaveLength(1);
      expect(plain.scenarios[0]?.["scenario"]).toBe("admin");
      expect(plain.scenarios[0]).not.toHaveProperty("explanation");
      expect(plain.catalog?.capabilities.length).toBeGreaterThan(0);
      expect(plain.coverage?.unreached).toEqual([]);
      expect(plain.failures).toEqual([]);
      const first = output();
      expect(first).not.toMatch(/srf_|reg_|capturedAt|surfaceId/);

      captured = [];
      expect(await main(["inspect", "admin", "--config", CONFIG, "--json"])).toBe(0);
      expect(output()).toBe(first);

      captured = [];
      await main(["inspect", "admin", "--config", CONFIG, "--json", "--depth", "runtime"]);
      const runtimeOnly = JSON.parse(output()) as { catalog: unknown; coverage: unknown };
      expect(runtimeOnly.catalog).toBeNull();
      expect(runtimeOnly.coverage).toBeNull();

      captured = [];
      await main(["inspect", "anonymous", "--config", CONFIG, "--json"]);
      const hiddenWithoutAttribution = (
        JSON.parse(output()) as {
          scenarios: Array<{ capabilities: Array<{ outcome: string }>; explanation?: unknown }>;
        }
      ).scenarios[0]!;
      expect(hiddenWithoutAttribution.capabilities.length).toBeGreaterThan(0);
      expect(hiddenWithoutAttribution.capabilities.every((row) => row.outcome === "hide")).toBe(true);
      expect(hiddenWithoutAttribution.explanation).toBeUndefined();

      captured = [];
      await main(["inspect", "anonymous", "--config", CONFIG, "--json", "--explain"]);
      const explained = (
        JSON.parse(output()) as {
          scenarios: Array<{
            snapshot: { components: unknown[] };
            capabilities: Array<{ outcome: string }>;
            explanation: {
              capabilities: Array<{ outcome: string; policies: Array<{ name: string }> }>;
            };
          }>;
        }
      ).scenarios[0]!;
      // Authority hides: nothing in the snapshot, everything in the explanation.
      expect(explained.snapshot.components).toHaveLength(0);
      expect(explained).toHaveProperty("capabilities");
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
      // empty surface, not a repeat of the first (D11). It says so as an
      // authority decision rather than as an absence of annotation, because the
      // capabilities are all there — a policy hid them (AS-CLI-007). They now
      // print as rows marked `hidden` rather than as a count alone.
      expect(all).toContain("hidden");
      expect(all.slice(all.indexOf("scenario anonymous"))).toContain("devices.table.sort");

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

describe("--depth selects which halves are computed (AS-CLI-008)", () => {
  it(
    "computes both by default, and says so on the way past",
    async () => {
      expect(await main(["inspect", "admin", "--config", CONFIG, "--plain"])).toBe(0);
      const full = output();
      expect(full).toContain("authored (upper bound)"); // the catalog
      expect(full).toContain("scenario admin"); // the projection
      expect(full).toContain("reached"); // the join
    },
    TIMEOUT,
  );

  it(
    "computes only the catalog at --depth static, mounting nothing",
    async () => {
      expect(await main(["inspect", "--depth", "static", "--config", CONFIG, "--plain"])).toBe(0);
      expect(output()).toContain("authored (upper bound)");
      expect(output()).not.toContain("scenario admin");
      // No mount ⇒ nothing reached anything ⇒ no verdict to state.
      expect(output()).not.toContain("reached");
    },
    TIMEOUT,
  );

  it(
    "computes only the projection at --depth runtime, skipping the TypeScript program",
    async () => {
      expect(
        await main(["inspect", "admin", "--depth", "runtime", "--config", CONFIG, "--plain"]),
      ).toBe(0);
      expect(output()).toContain("scenario admin");
      expect(output()).not.toContain("authored (upper bound)");
      expect(output()).not.toContain("UNREACHED");
    },
    TIMEOUT,
  );

  it(
    "refuses a depth that cannot answer the command",
    async () => {
      // A baseline is a projection. At `--depth static` nothing is mounted, so
      // there is nothing to compare and nothing to write — and saying so beats
      // reporting a vacuous match.
      expect(await main(["check", "--depth", "static", "--config", CONFIG, "--plain"])).toBe(2);
      expect(output()).toContain("nothing to compare");

      captured = [];
      expect(await main(["snapshot", "--depth", "static", "--config", CONFIG, "--plain"])).toBe(2);
      expect(output()).toContain("nothing to write");
    },
    TIMEOUT,
  );
});

describe("registrations rejected during a mount are reported (AS-CLI-006)", () => {
  const REJECTED = fileURLToPath(
    new URL("./fixtures/rejected/agent-surface.config.tsx", import.meta.url),
  );

  it(
    "names the rejected component and why, in the rendered view",
    async () => {
      expect(await main(["inspect", "--config", REJECTED, "--plain"])).toBe(0);
      const rendered = output();

      // The counts line has to carry it too: a reader who stops at the header
      // is the reader this whole correction is for.
      expect(rendered).toContain("1 registration rejected");
      expect(rendered).toContain("REJECTED");
      expect(rendered).toContain("dup.panel (default)");
      expect(rendered).toContain("duplicate");
      expect(rendered).toContain("scope dup");

      // The surviving registration is still reported normally — first-wins.
      expect(rendered).toContain("ping");
    },
    TIMEOUT,
  );

  it(
    "makes check fail even after the rejected projection was snapshotted",
    async () => {
      expect(
        await main(["snapshot", "--config", REJECTED, "--baseline-dir", baselineDir]),
      ).toBe(0);
      captured = [];
      expect(await main(["check", "--config", REJECTED, "--baseline-dir", baselineDir])).toBe(1);
      expect(output()).toContain("REJECTED REGISTRATIONS");
      expect(output()).toContain("dup.panel");
    },
    TIMEOUT,
  );

  it(
    "carries them in --json, and always as a present key",
    async () => {
      expect(await main(["inspect", "--config", REJECTED, "--json"])).toBe(0);
      const rejected = (
        JSON.parse(output()) as {
          scenarios: Array<{
            rejections: Array<{ componentType: string; instanceId: string; reason: string }>;
          }>;
        }
      ).scenarios[0]!;
      expect(rejected.rejections).toEqual([
        { componentType: "dup.panel", instanceId: "default", reason: "duplicate" },
      ]);

      // A healthy mount reports an empty array, not a missing key: a consumer
      // must not have to tell "none" apart from "this CLI is too old to say".
      captured = [];
      expect(await main(["inspect", "admin", "--config", CONFIG, "--json"])).toBe(0);
      const healthy = (
        JSON.parse(output()) as { scenarios: Array<{ rejections: unknown[] }> }
      ).scenarios[0]!;
      expect(healthy.rejections).toEqual([]);
    },
    TIMEOUT,
  );
});

describe("counts are never printed without their qualifier (AS-CLI-007)", () => {
  it(
    "prints the hidden count without --explain, and keeps attribution behind it",
    async () => {
      // `anonymous` is the case the old output got wrong: every capability
      // hidden by authority rendered as `0 callable, 0 visible-disabled`, which
      // reads as an app that annotated nothing.
      expect(await main(["inspect", "anonymous", "--config", CONFIG, "--plain"])).toBe(0);
      const bare = output();
      expect(bare).toContain("11 hidden");
      expect(bare).not.toContain("Nothing is registered");
      // The count moved; the attribution did not.
      expect(bare).not.toContain("policy authenticated");

      captured = [];
      await main(["inspect", "anonymous", "--config", CONFIG, "--plain", "--explain"]);
      expect(output()).toContain("policy authenticated");
    },
    TIMEOUT,
  );

  it(
    "names the active scope, because a scope filters the counts",
    async () => {
      expect(
        await main(["inspect", "admin", "--config", CONFIG, "--plain", "--scope", "devices"]),
      ).toBe(0);
      const scoped = output();
      expect(scoped).toContain("scope devices");
      // Scoped out, so the count it produced is smaller than the unscoped one.
      expect(scoped).not.toContain("app.navigation");

      captured = [];
      await main(["inspect", "admin", "--config", CONFIG, "--plain"]);
      expect(output()).not.toContain("scope ");
    },
    TIMEOUT,
  );

  it(
    "makes a green check name the scenarios it compared, and drop the caveat it can now answer",
    async () => {
      expect(await main(["snapshot", "--config", CONFIG, "--baseline-dir", baselineDir])).toBe(0);
      captured = [];
      expect(await main(["check", "--config", CONFIG, "--baseline-dir", baselineDir])).toBe(0);
      expect(output()).toContain("admin, anonymous");

      // It used to have to add that this was a statement about these scenarios
      // only, and point at a different command for the rest. At `--depth full`
      // there is no rest: the verdict is right there, in the same output.
      expect(output()).toContain("authored");
      expect(output()).toContain("reached");
      expect(output()).not.toContain("statement about these scenarios only");
    },
    TIMEOUT,
  );

  it(
    "keeps the caveat exactly where it is still true",
    async () => {
      // `--depth runtime` skips the catalog, so this check really is a statement
      // about these scenarios only — and has to say so.
      await main(["snapshot", "--config", CONFIG, "--baseline-dir", baselineDir]);
      captured = [];
      expect(
        await main([
          "check",
          "--config",
          CONFIG,
          "--baseline-dir",
          baselineDir,
          "--depth",
          "runtime",
        ]),
      ).toBe(0);
      expect(output()).toContain("statement about these scenarios only");
      expect(output()).toContain("--depth full");
    },
    TIMEOUT,
  );
});
