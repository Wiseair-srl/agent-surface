// Conformance: AS-COVER-001 (every statically resolvable registration call site
// appears in the inventory), AS-COVER-002 (an unresolvable call site is emitted
// with resolution "unresolved" and an origin, never omitted), AS-COVER-003
// (`capabilities` exits non-zero on an unresolved entry unless
// --allow-unresolved), AS-COVER-004 (a policy-hidden capability is classified
// reached), AS-COVER-005 (exit codes mirror AS-CLI-002; a stale allowlist entry
// fails), AS-COVER-006 (the inventory is never reachable from core).
//
// These drive the real `main()`. The fixture app authors three components and
// mounts one of them, which is the only shape that can prove a coverage gap:
// an unreached capability is invisible to `inspect`, `--explain` and `check`
// alike, because all three can only see what a scenario mounted.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as coreRoot from "@agent-surface/core";
import { main } from "../src/bin.js";
import { extractCapabilities, authoredIds, unresolved } from "../src/extract.js";
import { buildCoverageReport, coverageExitCode } from "../src/coverage.js";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/coverage/agent-surface.config.tsx", import.meta.url),
);
const DEVICES = fileURLToPath(
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

function writeAllowlist(entries: Record<string, string>): void {
  writeFileSync(join(baselineDir, "coverage-allow.json"), JSON.stringify(entries, null, 2));
}

beforeEach(() => {
  baselineDir = mkdtempSync(join(tmpdir(), "agent-surface-coverage-"));
  capture();
});

afterEach(() => {
  restore?.();
  restore = undefined;
  rmSync(baselineDir, { recursive: true, force: true });
});

describe("the static inventory (AS-COVER-001)", () => {
  it("finds every capability a resolvable call site authors, without mounting anything", () => {
    const inventory = extractCapabilities({ root: dirname(FIXTURE) });
    const ids = authoredIds(inventory);

    // Both halves of the mounted component, and the one nothing imports.
    expect([...ids].sort()).toEqual([
      "view:cov.mounted.poke",
      "view:cov.mounted.read",
      "view:cov.unmounted.toCsv",
    ]);

    // Identity comes from the call site, so the origin has to be usable.
    const toCsv = inventory.capabilities.find(
      (c) => c.capabilityId === "view:cov.unmounted.toCsv",
    );
    expect(toCsv?.origin.file).toBe("Unmounted.tsx");
    expect(toCsv?.origin.line).toBeGreaterThan(0);
    expect(toCsv?.kind).toBe("action");
    expect(toCsv?.description).toBe("exports the current view");
    expect(toCsv?.effect).toBe("local-state");
    expect(toCsv?.resolution).toBe("static");
  });

  it("never claims to have analyzed the domain plane", () => {
    // Reporting zero domain capabilities would read as "there are none" rather
    // than "nobody looked" — the inventory says which one it means (OQ-1).
    expect(extractCapabilities({ root: dirname(FIXTURE) }).domain).toBe("not-analyzed");
  });

  it("resolves a description split across concatenated literals", () => {
    // Descriptions are the provider's cached prompt prefix (D28), so they are
    // long enough that authors wrap them. That is not a dynamic description.
    const inventory = extractCapabilities({
      root: dirname(DEVICES),
    });
    const set = inventory.capabilities.find((c) => c.capabilityId === "view:devices.filters.set");
    expect(set?.description).toContain("omitted fields are unchanged");
    expect(set?.description).toContain("normal data fetching");
  });
});

describe("an unreadable call site is reported, never dropped (AS-COVER-002)", () => {
  it("emits it with an origin and a note naming the construct", () => {
    const entries = unresolved(extractCapabilities({ root: dirname(FIXTURE) }));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.origin.file).toBe("Dynamic.tsx");
    expect(entries[0]?.origin.line).toBeGreaterThan(0);
    expect(entries[0]?.note).toContain("`type` is not a string literal");
    // It must not have been silently counted as a capability either.
    expect(authoredIds(extractCapabilities({ root: dirname(FIXTURE) }))).not.toContain(
      "view:cov.dynamic.go",
    );
  });
});

describe("capabilities exit codes (AS-COVER-003)", () => {
  it(
    "exits 1 when any entry is unresolved, and 0 once the gap is accepted knowingly",
    async () => {
      expect(await main(["capabilities", "--config", FIXTURE, "--plain"])).toBe(1);
      expect(output()).toContain("Dynamic.tsx");
      expect(output()).toContain("--allow-unresolved");

      captured = [];
      expect(
        await main(["capabilities", "--config", FIXTURE, "--plain", "--allow-unresolved"]),
      ).toBe(0);
      // Accepting the gap must not hide it: the entry is still in the report.
      expect(output()).toContain("Dynamic.tsx");
    },
    TIMEOUT,
  );

  it(
    "exits 0 on a program it fully understood",
    async () => {
      expect(await main(["capabilities", "--config", DEVICES, "--plain"])).toBe(0);
      expect(output()).toContain("authored (upper bound)");
      expect(output()).toContain("view:devices.table.sort");
    },
    TIMEOUT,
  );
});

describe("a policy-hidden capability was still reached (AS-COVER-004)", () => {
  it(
    "does not report the anonymous scenario's hidden surface as a coverage gap",
    async () => {
      // Signed out, authority hides all eleven capabilities (D11): nothing
      // reaches the snapshot. Joining on the snapshot would make every one of
      // them a false gap — the union is taken over the explanation, where a
      // hide is a deliberate decision the policy made *about a capability a
      // scenario mounted*.
      expect(
        await main([
          "coverage",
          "anonymous",
          "--config",
          DEVICES,
          "--baseline-dir",
          baselineDir,
          "--plain",
        ]),
      ).toBe(0);
      expect(output()).toContain("every authored capability is reached by a scenario");
      expect(output()).not.toContain("unreached");
    },
    TIMEOUT,
  );

  it("classifies a hidden capability as reached in the join itself", () => {
    const report = buildCoverageReport({
      authored: new Set(["view:a.b", "view:a.c"]),
      origins: new Map([["view:a.c", { file: "a.tsx", line: 1 }]]),
      // `view:a.b` was mounted and hidden; `view:a.c` was never mounted.
      reachedIds: new Set(["view:a.b"]),
      scenarios: ["default"],
      unresolved: [],
      allowlist: {},
      allowlistPath: "/dev/null",
    });
    expect(report.reached).toBe(1);
    expect(report.unreached.map((u) => u.capabilityId)).toEqual(["view:a.c"]);
  });
});

describe("coverage exit codes and the allowlist ratchet (AS-COVER-005)", () => {
  it(
    "exits 1 on a gap, naming the capability and where it was authored",
    async () => {
      expect(
        await main(["coverage", "--config", FIXTURE, "--baseline-dir", baselineDir, "--plain"]),
      ).toBe(1);
      const report = output();
      expect(report).toContain("unreached");
      expect(report).toContain("view:cov.unmounted.toCsv");
      expect(report).toContain("Unmounted.tsx");
      expect(report).toContain("add a scenario, or delete the component");
    },
    TIMEOUT,
  );

  it(
    "stops failing on an allowlisted capability, and keeps reporting it",
    async () => {
      writeAllowlist({
        "view:cov.unmounted.toCsv": "legacy export screen, scheduled for deletion",
      });
      await main(["coverage", "--config", FIXTURE, "--baseline-dir", baselineDir, "--plain"]);
      const report = output();
      expect(report).toContain("allowlisted");
      // The unresolved call site is a separate gap and still fails the command,
      // so the allowlist cannot be used to wave through an unread codebase.
      expect(report).not.toContain("unreached  (");
      expect(report).toContain("could not be read");
    },
    TIMEOUT,
  );

  it(
    "fails on an allowlist entry that is no longer unreached, so the list cannot rot",
    async () => {
      writeAllowlist({ "view:cov.mounted.poke": "this one is reached — the entry has rotted" });
      expect(
        await main(["coverage", "--config", FIXTURE, "--baseline-dir", baselineDir, "--plain"]),
      ).toBe(1);
      expect(output()).toContain("stale allowlist entries");
      expect(output()).toContain("view:cov.mounted.poke");
    },
    TIMEOUT,
  );

  it("mirrors AS-CLI-002: 0 clean, 1 gap, and undeclared never fails on its own", () => {
    const clean = buildCoverageReport({
      authored: new Set(["view:a.b"]),
      origins: new Map(),
      reachedIds: new Set(["view:a.b"]),
      scenarios: ["default"],
      unresolved: [],
      allowlist: {},
      allowlistPath: "/dev/null",
    });
    expect(coverageExitCode(clean)).toBe(0);

    // A capability registered dynamically is legitimate, and indistinguishable
    // from an extractor gap from the outside (OQ-4). Reported, not failed.
    const undeclared = buildCoverageReport({
      authored: new Set(["view:a.b"]),
      origins: new Map(),
      reachedIds: new Set(["view:a.b", "view:surprise.c"]),
      scenarios: ["default"],
      unresolved: [],
      allowlist: {},
      allowlistPath: "/dev/null",
    });
    expect(undeclared.undeclared).toEqual(["view:surprise.c"]);
    expect(coverageExitCode(undeclared)).toBe(0);
  });

  it("holds domain capabilities apart from undeclared ones", () => {
    // The inventory never claimed to analyze that plane, so filing them as
    // "no static origin" would report a stated boundary as a defect.
    const report = buildCoverageReport({
      authored: new Set(["view:a.b"]),
      origins: new Map(),
      reachedIds: new Set(["view:a.b", "domain:devices.disable"]),
      scenarios: ["default"],
      unresolved: [],
      allowlist: {},
      allowlistPath: "/dev/null",
    });
    expect(report.domainReached).toEqual(["domain:devices.disable"]);
    expect(report.undeclared).toEqual([]);
    expect(coverageExitCode(report)).toBe(0);
  });

  it(
    "exits 2 on a usage error without reading a program",
    async () => {
      expect(await main(["coverage", "--config", "/nonexistent/agent-surface.config.tsx"])).toBe(1);
      captured = [];
      expect(await main(["capabilities", "--nonsense"])).toBe(2);
    },
    TIMEOUT,
  );
});

describe("the inventory is never agent-facing (AS-COVER-006)", () => {
  it("is absent from the package root that adapters import", () => {
    // It lives in @agent-surface/cli, which no adapter imports and no
    // application ships — mirroring AS-EXPLAIN-004. A capability catalog on the
    // package root would be an exposure path with extra steps.
    for (const name of ["extractCapabilities", "authoredIds", "buildCoverageReport"]) {
      expect(name in coreRoot).toBe(false);
    }
    expect(
      Object.keys(coreRoot).filter(
        (key) => key.toLowerCase().includes("coverage") || key.toLowerCase().includes("authored"),
      ),
    ).toEqual([]);
  });

  it("creates nothing: the extractor only reads, and registers no capability", () => {
    // Directive §2.1 — a capability exists only through reviewed registration
    // code. This module reads exactly that code and produces a report.
    const before = extractCapabilities({ root: dirname(FIXTURE) });
    const after = extractCapabilities({ root: dirname(FIXTURE) });
    expect(after.capabilities).toEqual(before.capabilities);
    expect(before.capabilities.every((c) => c.origin.file.length > 0)).toBe(true);
  });
});
