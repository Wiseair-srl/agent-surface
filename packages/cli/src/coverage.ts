/**
 * `coverage` — authored minus reached (`AS-COVER-004…005`, D36).
 *
 * The inventory says what the codebase authors; the scenarios say what a mount
 * surfaces. Neither half alone answers "which authored capability does no
 * scenario reach", because that is a set difference no command computed.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthoredCapability } from "./extract.js";

export const ALLOWLIST_FILE = "coverage-allow.json";

/**
 * A committed list of unreached capabilities a repository has decided not to
 * fix yet, each with a reason. Adoption has to ratchet rather than gate: a
 * codebase turning this on with 200 unreached capabilities cannot fix them in
 * one pull request, and a check that can only be adopted big-bang is a check
 * that never gets adopted.
 */
export type CoverageAllowlist = Record<string, string>;

export function allowlistPathFor(baselineDir: string): string {
  return join(baselineDir, ALLOWLIST_FILE);
}

export function readAllowlist(path: string): CoverageAllowlist {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must be a JSON object of { "capabilityId": "reason" }`);
  }
  const allowlist: CoverageAllowlist = {};
  for (const [id, reason] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new Error(`${path}: "${id}" needs a non-empty reason string`);
    }
    allowlist[id] = reason;
  }
  return allowlist;
}

export interface UnreachedCapability {
  capabilityId: string;
  origin: { file: string; line: number };
}

export interface CoverageReport {
  /** Distinct capability ids the inventory resolved. */
  authored: number;
  /** How many of them at least one scenario surfaced. */
  reached: number;
  scenarios: string[];
  /** Authored, surfaced by no scenario, and not allowlisted — the finding. */
  unreached: UnreachedCapability[];
  /**
   * Present at runtime with no static origin: a dynamic registration, or a gap
   * in the extractor. `view:` only — see `domainReached`.
   */
  undeclared: string[];
  /**
   * `domain:` capabilities a scenario surfaced. Held apart from `undeclared`
   * because the inventory never claimed to analyze that plane: filing them as
   * "no static origin" would report the design's own stated boundary as a
   * defect, which is the misleading check this whole command rejects.
   */
  domainReached: string[];
  /** Carried forward from the inventory. */
  unresolved: AuthoredCapability[];
  /** Unreached, but listed in the allowlist. */
  allowed: string[];
  /** Listed in the allowlist and reached anyway — the list has rotted. */
  staleAllowlist: string[];
  allowlistPath: string;
}

export interface BuildCoverageInput {
  authored: Set<string>;
  /** First origin seen for each authored id, for the report. */
  origins: Map<string, { file: string; line: number }>;
  /**
   * Every capability id any scenario's *explanation* held.
   *
   * The explanation, not the snapshot. A capability a policy hid **was**
   * reached: a scenario mounted it and the policy made a deliberate decision
   * about it. Classifying those as unreached would flood the report with the
   * library's own correct behaviour — in the example app the `anonymous`
   * scenario alone would contribute eleven false gaps.
   */
  reachedIds: Set<string>;
  scenarios: string[];
  unresolved: AuthoredCapability[];
  allowlist: CoverageAllowlist;
  allowlistPath: string;
}

export function buildCoverageReport(input: BuildCoverageInput): CoverageReport {
  const unreached: UnreachedCapability[] = [];
  const allowed: string[] = [];

  for (const id of [...input.authored].sort()) {
    if (input.reachedIds.has(id)) continue;
    if (id in input.allowlist) {
      allowed.push(id);
      continue;
    }
    unreached.push({ capabilityId: id, origin: input.origins.get(id) ?? { file: "?", line: 0 } });
  }

  // An allowlist entry that is no longer unreached fails the command, so the
  // list shrinks and cannot silently rot — the same idiom as the baselines
  // `check` already commits.
  const staleAllowlist = Object.keys(input.allowlist)
    .filter((id) => input.reachedIds.has(id) || !input.authored.has(id))
    .sort();

  const unaccounted = [...input.reachedIds].filter((id) => !input.authored.has(id)).sort();
  const domainReached = unaccounted.filter((id) => id.startsWith("domain:"));
  const undeclared = unaccounted.filter((id) => !id.startsWith("domain:"));

  return {
    authored: input.authored.size,
    reached: [...input.authored].filter((id) => input.reachedIds.has(id)).length,
    scenarios: input.scenarios,
    unreached,
    undeclared,
    domainReached,
    unresolved: input.unresolved,
    allowed,
    staleAllowlist,
    allowlistPath: input.allowlistPath,
  };
}

/**
 * `0` clean, `1` a gap.
 *
 * `undeclared` deliberately does not fail (OQ-4): a dynamically registered
 * capability is legitimate, and from the outside it is indistinguishable from
 * an extractor that missed something. Failing on it would punish the honest
 * case to catch the other one. It is reported, loudly, and revisited when a
 * codebase does it deliberately.
 */
export function coverageExitCode(report: CoverageReport): number {
  if (report.unreached.length > 0) return 1;
  if (report.unresolved.length > 0) return 1;
  if (report.staleAllowlist.length > 0) return 1;
  return 0;
}
