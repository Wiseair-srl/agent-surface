// Conformance: AS-COVER-001 (every statically resolvable registration call site
// appears in the catalog), AS-COVER-002 (an unresolvable call site is emitted
// with resolution "unresolved" and an origin, never omitted), AS-COVER-003
// (`check` fails on an unread call site unless --allow-unresolved), AS-COVER-004
// (a policy-hidden capability is classified reached), AS-COVER-005 (exit codes
// mirror AS-CLI-002; a stale allowlist entry fails), AS-COVER-006 (the catalog
// is never reachable from core), AS-COVER-007 (the gap reaches every command,
// and a scope filters the catalog by the same predicate as the mount),
// AS-CLI-008 (--depth static computes the catalog and mounts nothing),
// AS-CLI-011 (manifest domain denominator and effective scope), AS-CLI-012
// (compact static hierarchy with detail on demand), AS-COVER-008
// (unread call sites ratchet per semantic site),
// AS-COVER-009 (a wrapper hook's type resolves from its call sites, and a
// same-named function elsewhere is never attributed), AS-COVER-010 (a
// registration is identified through its import binding, so an alias resolves
// and an unfollowable binding is reported rather than dropped).
//
// These drive the real `main()`. The fixture app authors three components and
// mounts one of them, which is the only shape that can prove a coverage gap:
// an unreached capability is invisible to a mount, to `--explain` and to a
// baseline alike, because all three can only see what a scenario mounted.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as coreRoot from "@agent-surface/core";
import { main } from "../src/bin.js";
import { extractCapabilities, authoredIds, unresolved } from "../src/extract.js";
import { buildCoverageReport, coverageExitCode, unreadKey } from "../src/coverage.js";
import { renderCheckOverviewPlain } from "../src/render/plain.js";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/coverage/agent-surface.config.tsx", import.meta.url),
);
const UNMOUNTABLE = fileURLToPath(
  new URL("./fixtures/unmountable/agent-surface.config.tsx", import.meta.url),
);
const SPREAD = fileURLToPath(
  new URL("./fixtures/spread/agent-surface.config.tsx", import.meta.url),
);
const WRAPPER = fileURLToPath(
  new URL("./fixtures/wrapper/agent-surface.config.tsx", import.meta.url),
);
const ALIASED = fileURLToPath(
  new URL("./fixtures/aliased/agent-surface.config.tsx", import.meta.url),
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

/** The join's inputs, with only the field under test varying. */
function report(overrides: Partial<Parameters<typeof buildCoverageReport>[0]> = {}) {
  return buildCoverageReport({
    authored: new Set(["view:a.b"]),
    origins: new Map(),
    reachedIds: new Set(["view:a.b"]),
    scenarios: ["default"],
    unresolved: [],
    allowlist: {},
    allowlistPath: "/dev/null",
    unreadAllowlistPath: "/dev/null",
    ...overrides,
  });
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

describe("the static catalog (AS-COVER-001)", () => {
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
    // than "nobody looked" — the catalog says which one it means (OQ-1).
    expect(extractCapabilities({ root: dirname(FIXTURE) }).domain).toBe("not-analyzed");
  });

  it("resolves a description split across concatenated literals", () => {
    // Descriptions are the provider's cached prompt prefix (D28), so they are
    // long enough that authors wrap them. That is not a dynamic description.
    const inventory = extractCapabilities({ root: dirname(DEVICES) });
    const set = inventory.capabilities.find((c) => c.capabilityId === "view:devices.filters.set");
    expect(set?.description).toContain("omitted fields are unchanged");
    expect(set?.description).toContain("normal data fetching");
  });

  it(
    "is what --depth static prints, with no Vite server and no mount",
    async () => {
      expect(await main(["inspect", "--depth", "static", "--config", DEVICES, "--plain"])).toBe(0);
      const rendered = output();
      // The run header comes first — what was read, at which depth, under which
      // scope — and the catalog it produced follows as its own block.
      expect(rendered).toMatch(/^SURFACE INSPECT\n/);
      expect(rendered).toMatch(/^STATIC CATALOG\nSTATUS\s+COMPLETE/m);
      expect(rendered).toContain("every capability identity resolved");
      expect(rendered).toContain("authored (upper bound)");
      expect(rendered).toContain("DYNAMIC META");
      expect(rendered).toContain("COMPONENTS");
      expect(rendered).toContain("view:devices.table.sort");
      expect(rendered.split("\n").length).toBeLessThan(40);
      // Nothing was mounted, so no scenario header can appear.
      expect(rendered).not.toContain("scenario admin");

      captured = [];
      expect(
        await main(["inspect", "--depth", "static", "--config", DEVICES, "--plain", "--detail"]),
      ).toBe(0);
      expect(output()).toContain("CAPABILITY DETAILS");
      expect(output()).toContain("DevicesTable.tsx");
    },
    TIMEOUT,
  );
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

  // The guarantee is not "an unreadable *call site* is reported" but "a
  // registration this extractor cannot fully enumerate is never absent from
  // both lists". A spread of members read the call site fine and still lost the
  // registration from the catalog *and* from the unread entries that exist to
  // say the catalog is incomplete (#29).
  describe("a spread that could carry capabilities", () => {
    const inventory = (): ReturnType<typeof extractCapabilities> =>
      extractCapabilities({ root: dirname(SPREAD) });

    it("reports a registration whose members all arrive through a spread", () => {
      // `type` is a literal, so this is unmistakably a registration — it simply
      // has no enumerable members. Before the fix it appeared nowhere at all.
      const ids = authoredIds(inventory());
      expect([...ids].some((id) => id.startsWith("view:spread.all."))).toBe(false);

      const entry = unresolved(inventory()).find((c) => c.note?.includes("spread.all"));
      expect(entry, "spread.all must not vanish from both lists").toBeDefined();
      expect(entry?.origin.file).toBe("Shapes.tsx");
      expect(entry?.origin.line).toBeGreaterThan(0);
      expect(entry?.note).toContain("buildMembers()");
    });

    it("reports it even when a literal group resolved alongside the spread", () => {
      // The half that resolves must not read as the whole: a literal
      // `observations` says nothing about the `actions` the spread may add.
      expect(authoredIds(inventory())).toContain("view:spread.some.read");
      expect(
        unresolved(inventory()).find((c) => c.note?.includes("spread.some")),
        "a resolved half must not suppress the unread other half",
      ).toBeDefined();
    });

    it("stays quiet when the spread's key set is knowable and carries no group", () => {
      // `...(props.instance ? { instanceId } : {})` is the shape every example
      // uses. Its keys are written out and `instanceId` is not part of a
      // capability id, so reporting it would flood the documented common case.
      expect(authoredIds(inventory())).toContain("view:spread.instance.poke");
      expect(unresolved(inventory()).some((c) => c.note?.includes("spread.instance"))).toBe(false);
    });

    it("keeps the example app quiet, which uses exactly that shape", () => {
      expect(unresolved(extractCapabilities({ root: dirname(DEVICES) }))).toEqual([]);
    });
  });
});

describe("an unread call site fails the gate, not the viewer (AS-COVER-003)", () => {
  it(
    "makes check exit 1, and 0 once the gap is accepted knowingly",
    async () => {
      // The catalog is `unreached`'s denominator, so holes in it make that count
      // a floor rather than an answer. Accepting the gap still prints it.
      writeAllowlist({ "view:cov.unmounted.toCsv": "a separate bucket, allowlisted here" });
      expect(
        await main(["check", "--config", FIXTURE, "--baseline-dir", baselineDir, "--plain"]),
      ).toBe(1);
      expect(output()).toContain("UNREAD CALL SITES");
      expect(output()).toContain("Dynamic.tsx");

      captured = [];
      await main(["snapshot", "--config", FIXTURE, "--baseline-dir", baselineDir, "--plain"]);
      captured = [];
      expect(
        await main([
          "check",
          "--config",
          FIXTURE,
          "--baseline-dir",
          baselineDir,
          "--plain",
          "--allow-unresolved",
        ]),
      ).toBe(0);
      expect(output()).toContain("Dynamic.tsx");
    },
    TIMEOUT,
  );

  it(
    "never makes inspect exit non-zero on a finding — check is the only gate",
    async () => {
      // A viewer that sometimes fails is a viewer nobody puts in a pipeline,
      // and the discipline is preserved where it matters: the entry is printed.
      expect(await main(["inspect", "--config", FIXTURE, "--plain"])).toBe(0);
      expect(output()).toContain("UNREAD CALL SITES");
      expect(output()).toContain("UNREACHED");
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
          "inspect",
          "anonymous",
          "--config",
          DEVICES,
          "--baseline-dir",
          baselineDir,
          "--plain",
        ]),
      ).toBe(0);
      expect(output()).toContain("every authored capability is reached by a scenario");
      expect(output()).not.toContain("UNREACHED");
    },
    TIMEOUT,
  );

  it("classifies a hidden capability as reached in the join itself", () => {
    const joined = report({
      authored: new Set(["view:a.b", "view:a.c"]),
      origins: new Map([["view:a.c", { file: "a.tsx", line: 1 }]]),
      // `view:a.b` was mounted and hidden; `view:a.c` was never mounted.
      reachedIds: new Set(["view:a.b"]),
    });
    expect(joined.reached).toBe(1);
    expect(joined.unreached.map((u) => u.capabilityId)).toEqual(["view:a.c"]);
  });
});

describe("exit codes and the allowlist ratchet (AS-COVER-005)", () => {
  it("attributes each failing check to its own overview row", () => {
    const base = {
      status: "FAIL" as const,
      baselineCurrent: 1,
      baselineTotal: 1,
      scenarioManifestOk: true,
      rejected: 0,
      mountFailures: 0,
      stats: [{ scenario: "default", callable: 1, disabled: 0, hidden: 0, rejected: 0 }],
      unresolvedAllowed: false,
    };
    const unread = report({
      unresolved: [
        {
          capabilityId: "<unresolved>",
          kind: "action",
          origin: { file: "a.tsx", line: 1, site: "site-a" },
          resolution: "unresolved",
        },
      ],
    });
    const unreadOutput = renderCheckOverviewPlain({ ...base, coverage: unread });
    expect(unreadOutput).toContain("Coverage      PASS");
    expect(unreadOutput).toContain("Catalog       FAIL");

    const domain = report({
      reachedIds: new Set(["view:a.b", "domain:devices.disable"]),
      domainAuthoritative: true,
    });
    const domainOutput = renderCheckOverviewPlain({ ...base, coverage: domain });
    expect(domainOutput).toContain("Coverage      PASS");
    expect(domainOutput).toContain("Domain        FAIL");
    expect(domainOutput).toContain("absent from manifest");
  });

  it(
    "makes check exit 1 on a gap, naming the capability and where it was authored",
    async () => {
      await main(["snapshot", "--config", FIXTURE, "--baseline-dir", baselineDir, "--plain"]);
      captured = [];
      expect(
        await main([
          "check",
          "--config",
          FIXTURE,
          "--baseline-dir",
          baselineDir,
          "--plain",
          "--allow-unresolved",
        ]),
      ).toBe(1);
      const rendered = output();
      expect(rendered).toContain("UNREACHED");
      expect(rendered).toContain("view:cov.unmounted.toCsv");
      expect(rendered).toContain("Unmounted.tsx");
    },
    TIMEOUT,
  );

  it(
    "stops failing on an allowlisted capability, and keeps reporting it",
    async () => {
      await main(["snapshot", "--config", FIXTURE, "--baseline-dir", baselineDir, "--plain"]);
      writeAllowlist({
        "view:cov.unmounted.toCsv": "legacy export screen, scheduled for deletion",
      });
      captured = [];
      expect(
        await main([
          "check",
          "--config",
          FIXTURE,
          "--baseline-dir",
          baselineDir,
          "--plain",
          "--allow-unresolved",
        ]),
      ).toBe(0);
      expect(output()).toContain("allowlisted");
      expect(output()).not.toContain("UNREACHED");
    },
    TIMEOUT,
  );

  it(
    "cannot be used to wave through an unread codebase",
    async () => {
      // The allowlist covers unreached capabilities only. `unresolved` is a
      // separate bucket with its own, separate acceptance.
      await main(["snapshot", "--config", FIXTURE, "--baseline-dir", baselineDir, "--plain"]);
      writeAllowlist({ "view:cov.unmounted.toCsv": "allowlisted" });
      captured = [];
      expect(
        await main(["check", "--config", FIXTURE, "--baseline-dir", baselineDir, "--plain"]),
      ).toBe(1);
      expect(output()).toContain("UNREAD CALL SITES");
    },
    TIMEOUT,
  );

  it(
    "fails on an allowlist entry that is no longer unreached, so the list cannot rot",
    async () => {
      await main(["snapshot", "--config", FIXTURE, "--baseline-dir", baselineDir, "--plain"]);
      writeAllowlist({ "view:cov.mounted.poke": "this one is reached — the entry has rotted" });
      captured = [];
      expect(
        await main([
          "check",
          "--config",
          FIXTURE,
          "--baseline-dir",
          baselineDir,
          "--plain",
          "--allow-unresolved",
        ]),
      ).toBe(1);
      expect(output()).toContain("STALE ALLOWLIST");
      expect(output()).toContain("view:cov.mounted.poke");
    },
    TIMEOUT,
  );

  it("mirrors AS-CLI-002: 0 clean, 1 gap, and undeclared never fails on its own", () => {
    expect(coverageExitCode(report())).toBe(0);

    // A capability registered dynamically is legitimate, and indistinguishable
    // from an extractor gap from the outside (OQ-4). Reported, not failed.
    const undeclared = report({ reachedIds: new Set(["view:a.b", "view:surprise.c"]) });
    expect(undeclared.undeclared).toEqual(["view:surprise.c"]);
    expect(coverageExitCode(undeclared)).toBe(0);

    // An unread call site fails, and `--allow-unresolved` is the only way past.
    const unread = report({
      unresolved: [
        {
          capabilityId: "<unresolved>",
          kind: "action",
          origin: { file: "a.tsx", line: 1, site: "site-a" },
          resolution: "unresolved",
        },
      ],
    });
    expect(coverageExitCode(unread)).toBe(1);
    expect(coverageExitCode(unread, { allowUnresolved: true })).toBe(0);
  });

  it("holds domain capabilities apart from undeclared ones", () => {
    // The catalog never claimed to analyze that plane, so filing them as "no
    // static origin" would report a stated boundary as a defect.
    const joined = report({ reachedIds: new Set(["view:a.b", "domain:devices.disable"]) });
    expect(joined.domainReached).toEqual(["domain:devices.disable"]);
    expect(joined.undeclared).toEqual([]);
    expect(coverageExitCode(joined)).toBe(0);
  });

  it("uses an authoritative domain manifest as a failing denominator (AS-CLI-011)", () => {
    const joined = report({
      authored: new Set(["view:a.b", "domain:devices.disable", "domain:devices.retire"]),
      reachedIds: new Set(["view:a.b", "domain:devices.disable"]),
      domainAuthoritative: true,
    });
    expect(joined.domainReached).toEqual(["domain:devices.disable"]);
    expect(joined.unreached.map((entry) => entry.capabilityId)).toEqual([
      "domain:devices.retire",
    ]);
    expect(coverageExitCode(joined)).toBe(1);

    const outsideManifest = report({
      reachedIds: new Set(["view:a.b", "domain:devices.unknown"]),
      domainAuthoritative: true,
    });
    expect(outsideManifest.unmanifestedDomain).toEqual(["domain:devices.unknown"]);
    expect(coverageExitCode(outsideManifest)).toBe(1);
  });
});

describe("the gap reaches every command, and a scope cannot fake one (AS-COVER-007)", () => {
  it(
    "reports it from snapshot too, because that is the command that accepts a change",
    async () => {
      expect(
        await main(["snapshot", "--config", FIXTURE, "--baseline-dir", baselineDir, "--plain"]),
      ).toBe(0);
      expect(output()).toContain("UNREACHED");
      expect(output()).toContain("view:cov.unmounted.toCsv");
    },
    TIMEOUT,
  );

  it(
    "filters the catalog by the same predicate as the mount",
    async () => {
      // A scope filters the mount, so it has to filter the catalog too.
      // Without that, `--scope devices` reported both `app.navigation`
      // capabilities as ones "no scenario mounts" — over two that every
      // scenario mounts.
      expect(
        await main([
          "inspect",
          "--config",
          DEVICES,
          "--baseline-dir",
          baselineDir,
          "--plain",
          "--scope",
          "devices",
        ]),
      ).toBe(0);
      expect(output()).not.toContain("UNREACHED");
      expect(output()).not.toContain("view:app.navigation.goTo");
      // Every count names the scope it was computed under (AS-CLI-007) — in
      // the run header, in each scenario's own header, and in the summary.
      expect(output()).toContain("scope devices");
      expect(output()).toContain("devices — every count below is relative to it");
      expect(output()).toContain("9/9 authored capabilities reached");
      expect(output()).toContain("1 capability reached against the authoritative oRPC manifest");
    },
    TIMEOUT,
  );

  it(
    "emits no verdict at all when a scenario did not mount",
    async () => {
      // That scenario reached nothing, so every capability it would have
      // surfaced would be reported unreached. A verdict over a partial run is
      // the misleading check this whole package refuses to emit.
      expect(await main(["inspect", "--config", UNMOUNTABLE, "--plain"])).toBe(2);
      const rendered = output();
      expect(rendered).toContain("DID NOT MOUNT");
      expect(rendered).toContain("broken");
      expect(rendered).toContain("NO COVERAGE VERDICT");
      expect(rendered).not.toContain("UNREACHED");
      // The static half survived, and so did the scenario that does mount.
      expect(rendered).toContain("authored (upper bound)");
      expect(rendered).toContain("scenario ok");
      expect(rendered).toContain("brk.panel.poke");
    },
    TIMEOUT,
  );
});

describe("a wrapper hook's type resolves from its call sites (AS-COVER-009)", () => {
  const inventory = (): ReturnType<typeof extractCapabilities> =>
    extractCapabilities({ root: dirname(WRAPPER) });

  it("emits one capability set per literal a caller passes", () => {
    // The whole point of #31: one wrapper, many call sites. Reported unread,
    // this single line hid every capability every caller authored — 91% of one
    // real application's surface.
    const ids = [...authoredIds(inventory())].sort();
    expect(ids).toContain("view:wrap.devices.read");
    expect(ids).toContain("view:wrap.devices.poke");
    expect(ids).toContain("view:wrap.billing.read");
    expect(ids).toContain("view:wrap.billing.poke");
  });

  it("reads the destructured spelling too", () => {
    // `function useX({ type }: Props)` is as common as the positional one.
    expect(authoredIds(inventory())).toContain("view:wrap.named.read");
  });

  it("never attributes a call of a same-named function in another file", () => {
    // THE safety property. Resolving the impostor's call would put
    // `wrap.impostor` in the catalog with capabilities no component authors —
    // fabricating an entry, a failure this package has never had. Reporting
    // nothing is always the safe answer, so anything short of certainty
    // (a same-file declaration, or an import resolving to the wrapper's file)
    // resolves to nothing at all.
    const ids = [...authoredIds(inventory())];
    expect(ids.some((id) => id.includes("impostor"))).toBe(false);
  });

  it("resolves the literals and reports the caller that passes a variable", () => {
    // Partial beats all-or-nothing: 2 resolved plus 1 named unread line is a
    // truer catalog than 3 unread ones, and it stays honest about which.
    const entry = unresolved(inventory()).find((c) => c.note?.includes("usePanel()"));
    expect(entry).toBeDefined();
    expect(entry?.reason).toBe("dynamic-type");
    expect(entry?.note).toContain("2 call sites resolved");
    expect(entry?.note).toContain("1 passes a non-literal");
  });

  it("costs nothing extra: the join reuses the walk, and forces no type checker", () => {
    // Binding a large program to get `node.parent` would dwarf the extraction
    // itself, so the enclosing function is tracked on the way down instead.
    const before = Date.now();
    inventory();
    const withWrappers = Date.now() - before;
    const plain = ((): number => {
      const start = Date.now();
      extractCapabilities({ root: dirname(FIXTURE) });
      return Date.now() - start;
    })();
    // Same order of magnitude — this is a smoke test against accidentally
    // constructing a checker, not a benchmark.
    expect(withWrappers).toBeLessThan(Math.max(plain * 20, 5_000));
  });
});

describe("a registration is identified by what it imports (AS-COVER-010)", () => {
  const inventory = (): ReturnType<typeof extractCapabilities> =>
    extractCapabilities({ root: dirname(ALIASED) });

  it("resolves a hook imported under another name", () => {
    // The one place this extractor under-reported *silently*: matched on the
    // local identifier, an aliased registration was in neither list — no
    // capability, and no unread call site saying the catalog was short.
    const ids = [...authoredIds(inventory())].sort();
    expect(ids).toContain("view:alias.panel.read");
    expect(ids).toContain("view:alias.panel.poke");
  });

  it("resolves the namespace spelling, and now proves it instead of guessing", () => {
    // This one already worked — by coincidence, because the property name
    // happened to be spelled like the hook. The namespace binding is what makes
    // it an answer rather than a match on prose.
    expect(authoredIds(inventory())).toContain("view:alias.namespace.poke");
  });

  it("reaches an aliased granular hook, which the name match never saw", () => {
    // The verdict on a granular hook is unchanged (its type is not at the call
    // site, OQ-13). But an entry has to be *reached* to be reported, and under
    // an alias this call site was invisible — the codebase read as fully
    // covered because nobody looked at it.
    const entry = unresolved(inventory()).find((c) => c.origin.file === "Granular.tsx");
    expect(entry?.reason).toBe("granular-hook");
    expect(entry?.origin.line).toBeGreaterThan(0);
  });

  it("never attributes a same-named local function", () => {
    // The safety bar `callsWrapper` already holds: import bindings are per
    // file, so a local `useAC` elsewhere proves nothing. Resolving it would put
    // ids in the catalog no component authors, and a fabricated entry is worse
    // than a missing one — every other gap here understates, that one would
    // overstate.
    expect([...authoredIds(inventory())].some((id) => id.includes("impostor"))).toBe(false);
  });

  it("reports a hook that leaves a module renamed, rather than losing its callers", () => {
    // `export { useAgentComponent as useAC } from "…"`. Downstream call sites
    // carry nothing that proves they register, and following the chain is the
    // hop the wrapper resolution refuses for the same reason. So the gap is
    // reported at the line that opens it — and the registrations it hides stay
    // out of the catalog rather than being guessed into it.
    const entry = unresolved(inventory()).find((c) => c.origin.file === "Barrel.ts");
    expect(entry?.reason).toBe("dynamic-callee");
    expect(entry?.note).toContain("useAC");
    expect([...authoredIds(inventory())].some((id) => id.includes("alias.barrel"))).toBe(false);
  });

  it("reports a call through a computed member of our namespace", () => {
    // Knowing the module is ours is exactly what makes this reportable: an
    // unreadable call on some other object is not a registration at all.
    const entry = unresolved(inventory()).find((c) => c.origin.file === "Opaque.tsx");
    expect(entry?.reason).toBe("dynamic-callee");
    expect([...authoredIds(inventory())].some((id) => id.includes("alias.computed"))).toBe(false);
  });

  it("leaves nothing in the silent middle: every registration is in one list or the other", () => {
    // The whole guarantee, stated once. Every registration-shaped site in the
    // fixture either resolves to a capability or is named unread with a file
    // and a line; the impostor and the barrel's callers are neither, because
    // nothing proves they are ours. None of them disappears unremarked.
    expect([...authoredIds(inventory())].sort()).toEqual([
      "view:alias.namespace.poke",
      "view:alias.panel.poke",
      "view:alias.panel.read",
    ]);
    expect(
      unresolved(inventory())
        .map((c) => c.origin.file)
        .sort(),
    ).toEqual(["Barrel.ts", "Granular.tsx", "Opaque.tsx"]);
    expect(unresolved(inventory()).every((c) => c.origin.line > 0)).toBe(true);
  });
});

describe("unread call sites ratchet per entry, like unreached ones (AS-COVER-008)", () => {
  function writeUnreadAllowlist(entries: Record<string, string>): void {
    writeFileSync(join(baselineDir, "unresolved-allow.json"), JSON.stringify(entries, null, 2));
  }

  /** Every unread key a root produces, order-independent. */
  function keysFor(root: string): string[] {
    return unresolved(extractCapabilities({ root })).map(unreadKey).sort();
  }

  it("keys each semantic site, never the whole file/reason class", () => {
    // The line churns on every edit above the call site, and the note is
    // written for a human and gets reworded — the spread note changed in the
    // release that introduced it. A key built from either would invalidate
    // committed entries for a reason that has nothing to do with the surface.
    const entries = unresolved(extractCapabilities({ root: dirname(SPREAD) })).filter(
      (entry) => entry.reason === "spread-members",
    );
    const keys = entries.map(unreadKey);
    expect(new Set(keys).size).toBe(entries.length);
    expect(keys.every((key) => key.startsWith("Shapes.tsx#spread-members#"))).toBe(true);
  });

  it("survives an edit that is not to the call site", () => {
    // The regression that shipped this key: the fingerprint mixed in a window
    // of neighbouring source lines, so a comment two lines above moved it. The
    // committed entry then read as *stale* — and stale fails even through
    // `--allow-unresolved`, so there was no way past it but to re-paste a hash.
    //
    // Every edit below is churn: no registration changes, so no key may. Each
    // one is anchored on a landmark rather than on `origin.line`, which points
    // at the unread *property* — splicing there lands mid-object-literal and
    // tests nothing but the parser's error recovery.
    const above = (lines: string[]): number =>
      lines.findIndex((line) => line.startsWith("export function SpreadAll"));
    const churn: Array<[string, (lines: string[]) => void]> = [
      ["a banner at the top of the file", (lines) => lines.splice(0, 0, "// banner")],
      ["a comment above the component", (lines) => lines.splice(above(lines), 0, "// note")],
      [
        "a whole function above the component",
        (lines) => lines.splice(above(lines), 0, "function unrelated() {", "  return 1;", "}"),
      ],
      // The strongest case: inside the very object literal being read, between
      // the call's opening brace and the first property it resolves.
      ["a comment inside the registration", (lines) => lines.splice(above(lines) + 2, 0, "    // x")],
    ];

    const baseline = keysFor(dirname(SPREAD));
    expect(baseline.length).toBeGreaterThan(0);

    for (const [what, edit] of churn) {
      const root = mkdtempSync(join(tmpdir(), "as-churn-"));
      cpSync(dirname(SPREAD), root, { recursive: true });
      const file = join(root, "Shapes.tsx");
      const lines = readFileSync(file, "utf8").split("\n");
      edit(lines);
      writeFileSync(file, lines.join("\n"));

      // A broken splice would "pass" by losing the site entirely, so the count
      // is asserted alongside the keys.
      const moved = keysFor(root);
      expect(moved.length, `${what} changed how many sites are reported`).toBe(baseline.length);
      expect(moved, `${what} moved a key`).toEqual(baseline);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gives a twin site its own key, and does not move it by adding a third", () => {
    // Two byte-identical calls in one function are the only thing left that can
    // collide, so they are what the occurrence rank is for. Appending a third
    // must not renumber the two that were already accepted.
    const root = mkdtempSync(join(tmpdir(), "as-twin-"));
    cpSync(dirname(SPREAD), root, { recursive: true });
    const file = join(root, "Twins.tsx");
    const twin = (count: number): string =>
      [
        'import { useAgentComponent } from "@agent-surface/react";',
        "export function Twins(): React.ReactElement {",
        ...Array.from({ length: count }, () => '  useAgentComponent({ type: t, ...spread });'),
        "  return <div />;",
        "}",
        "declare const t: string;",
        "declare const spread: Record<string, unknown>;",
      ].join("\n");

    writeFileSync(file, twin(2));
    const two = keysFor(root).filter((key) => key.startsWith("Twins.tsx#"));
    expect(new Set(two).size).toBe(two.length);
    expect(two.length).toBe(2);

    writeFileSync(file, twin(3));
    const three = keysFor(root).filter((key) => key.startsWith("Twins.tsx#"));
    expect(three).toEqual(expect.arrayContaining(two));

    rmSync(root, { recursive: true, force: true });
  });

  it("gives every unread entry a reason code, so none is keyed on \"unknown\"", () => {
    for (const root of [dirname(SPREAD), dirname(FIXTURE), dirname(ALIASED)]) {
      for (const entry of unresolved(extractCapabilities({ root }))) {
        expect(entry.reason, `${entry.origin.file} has no reason code`).toBeDefined();
        expect(unreadKey(entry)).not.toContain("#unknown");
      }
    }
  });

  it(
    "stops failing check on a listed site, and keeps reporting it",
    async () => {
      await main(["snapshot", "--config", SPREAD, "--baseline-dir", baselineDir, "--plain"]);
      writeAllowlist({ "view:spread.some.read": "mounted only in another scenario" });

      captured = [];
      expect(
        await main(["check", "--config", SPREAD, "--baseline-dir", baselineDir, "--plain"]),
      ).toBe(1);

      const unreadEntries = unresolved(extractCapabilities({ root: dirname(SPREAD) }));
      writeUnreadAllowlist(
        Object.fromEntries(unreadEntries.map((entry) => [unreadKey(entry), "tracked in #31"])),
      );
      captured = [];
      expect(
        await main(["check", "--config", SPREAD, "--baseline-dir", baselineDir, "--plain"]),
      ).toBe(0);
      // Accepted is not hidden — the same discipline `--allow-unresolved` keeps.
      expect(output()).toContain("allowlisted");
    },
    TIMEOUT,
  );

  it(
    "fails on an entry the extractor can now read, so the list shrinks",
    async () => {
      await main(["snapshot", "--config", SPREAD, "--baseline-dir", baselineDir, "--plain"]);
      writeAllowlist({ "view:spread.some.read": "mounted only in another scenario" });
      const unreadEntries = unresolved(extractCapabilities({ root: dirname(SPREAD) }));
      writeUnreadAllowlist({
        ...Object.fromEntries(unreadEntries.map((entry) => [unreadKey(entry), "still unread"])),
        "Shapes.tsx#dynamic-type#gone": "a shape that no longer occurs here",
      });

      captured = [];
      expect(
        await main(["check", "--config", SPREAD, "--baseline-dir", baselineDir, "--plain"]),
      ).toBe(1);
      expect(output()).toContain("STALE UNREAD ALLOWLIST");
      expect(output()).toContain("Shapes.tsx#dynamic-type#gone");
      expect(output()).not.toContain("Shapes.tsx#spread-members#gone");
    },
    TIMEOUT,
  );

  it(
    "prints the key to paste, because nobody guesses the site fingerprint",
    async () => {
      expect(await main(["inspect", "--depth", "static", "--config", SPREAD, "--plain"])).toBe(0);
      expect(output()).toContain("allowlist key: Shapes.tsx#spread-members");
    },
    TIMEOUT,
  );

  it("composes with the blanket flag rather than replacing it", () => {
    const unread = {
      capabilityId: "<unresolved>",
      kind: "action" as const,
      origin: { file: "a.tsx", line: 1, site: "site-a" },
      resolution: "unresolved" as const,
      reason: "granular-hook" as const,
    };
    // Listed: does not fail, with or without the flag.
    const listed = report({
      unresolved: [unread],
      unreadAllowlist: { "a.tsx#granular-hook#site-a": "wrapper hook" },
    });
    expect(coverageExitCode(listed)).toBe(0);
    expect(listed.allowedUnread).toEqual(["a.tsx#granular-hook#site-a"]);

    // Unlisted: the flag is still the way past, for a codebase not ready to
    // enumerate them one by one.
    const bare = report({ unresolved: [unread] });
    expect(coverageExitCode(bare)).toBe(1);
    expect(coverageExitCode(bare, { allowUnresolved: true })).toBe(0);

    // A stale entry fails through the flag — a ratchet that can rot is not one.
    const stale = report({ unreadAllowlist: { "gone.tsx#dynamic-type#gone": "fixed long ago" } });
    expect(coverageExitCode(stale, { allowUnresolved: true })).toBe(1);
  });
});

describe("the catalog is never agent-facing (AS-COVER-006)", () => {
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
