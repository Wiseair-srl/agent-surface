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
export const UNREAD_ALLOWLIST_FILE = "unresolved-allow.json";

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

export function unreadAllowlistPathFor(baselineDir: string): string {
  return join(baselineDir, UNREAD_ALLOWLIST_FILE);
}

export function readAllowlist(path: string, keyName = "capabilityId"): CoverageAllowlist {
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
    throw new Error(`${path} must be a JSON object of { "${keyName}": "reason" }`);
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

/**
 * The key an unread call site is allowlisted under: `file#reason#site`.
 *
 * Neither half alone works. The line number churns on every edit above the call
 * site, so a ratchet keyed on it fails for a reason that has nothing to do with
 * the surface. The `note` is prose written for a human and gets reworded — the
 * spread note changed in the release that introduced it — so a key built from it
 * would invalidate committed entries on an edit nobody thought was behavioural.
 *
 * The site fingerprint is built from the call's own text and the named
 * enclosures around it, and from nothing positional — so an edit above it, or
 * beside it, or a reformat, leaves a committed entry matching, while a second
 * site in the same file receives its own key. See `stableSite`.
 */
export function unreadKey(entry: AuthoredCapability): string {
  return `${entry.origin.file}#${entry.reason ?? "unknown"}#${entry.origin.site}`;
}

export interface UnreachedCapability {
  capabilityId: string;
  origin: { file: string; line: number };
}

export interface CoverageReport {
  /** Distinct capability ids the inventory resolved, within any active scope. */
  authored: number;
  /** How many of them at least one scenario surfaced. */
  reached: number;
  scenarios: string[];
  /**
   * The scope every number here was computed under (`AS-CLI-007`). A scope
   * filters the catalog *and* the mount, so `10 authored` without it on screen
   * reads as a claim about the whole codebase when it is a claim about one
   * prefix of it.
   */
  scope?: string[];
  /**
   * Allowlist entries outside the active scope, which a scoped run cannot
   * judge: not unreached (nothing looked), not stale (nothing reached them).
   * Counted rather than silently dropped, so a scoped run never reads as a
   * verdict on the whole allowlist.
   */
  allowlistOutOfScope: number;
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
  /** Runtime domain entries absent from an explicitly configured manifest. */
  unmanifestedDomain: string[];
  domainAuthoritative: boolean;
  /** Carried forward from the inventory, minus anything allowlisted. */
  unresolved: AuthoredCapability[];
  /** Unreached, but listed in the allowlist. */
  allowed: string[];
  /** Listed in the allowlist and reached anyway — the list has rotted. */
  staleAllowlist: string[];
  allowlistPath: string;
  /** Unread, but listed in `unresolved-allow.json`. Keys, not entries. */
  allowedUnread: string[];
  /** Listed there and no longer unread — that list has rotted too. */
  staleUnreadAllowlist: string[];
  unreadAllowlistPath: string;
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
  scope?: string[];
  unresolved: AuthoredCapability[];
  /**
   * Already filtered to the active scope by the caller, which owns the scope
   * predicate. Entries outside it are counted in `allowlistOutOfScope`.
   */
  allowlist: CoverageAllowlist;
  allowlistOutOfScope?: number;
  allowlistPath: string;
  /** Keyed by `unreadKey()`. Absent is an empty list, not "accept everything". */
  unreadAllowlist?: CoverageAllowlist;
  unreadAllowlistPath: string;
  domainAuthoritative?: boolean;
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

  // The same ratchet, one bucket over. An unread call site a repository has
  // decided to live with — a shared wrapper hook, say — stops failing `check`
  // without turning the whole bucket off, and an entry that stops being unread
  // fails so the list shrinks.
  const unreadAllowlist = input.unreadAllowlist ?? {};
  const unread: AuthoredCapability[] = [];
  const allowedUnread = new Set<string>();
  for (const entry of input.unresolved) {
    const key = unreadKey(entry);
    if (key in unreadAllowlist) allowedUnread.add(key);
    else unread.push(entry);
  }
  const stillUnread = new Set(input.unresolved.map(unreadKey));
  const staleUnreadAllowlist = Object.keys(unreadAllowlist)
    .filter((key) => !stillUnread.has(key))
    .sort();

  const unaccounted = [...input.reachedIds].filter((id) => !input.authored.has(id)).sort();
  const domainReached = [...input.reachedIds].filter((id) => id.startsWith("domain:")).sort();
  const unmanifestedDomain = input.domainAuthoritative
    ? unaccounted.filter((id) => id.startsWith("domain:"))
    : [];
  const undeclared = unaccounted.filter((id) => !id.startsWith("domain:"));

  return {
    authored: input.authored.size,
    reached: [...input.authored].filter((id) => input.reachedIds.has(id)).length,
    scenarios: input.scenarios,
    ...(input.scope ? { scope: input.scope } : {}),
    allowlistOutOfScope: input.allowlistOutOfScope ?? 0,
    unreached,
    undeclared,
    domainReached,
    unmanifestedDomain,
    domainAuthoritative: input.domainAuthoritative === true,
    unresolved: unread,
    allowed,
    staleAllowlist,
    allowlistPath: input.allowlistPath,
    allowedUnread: [...allowedUnread].sort(),
    staleUnreadAllowlist,
    unreadAllowlistPath: input.unreadAllowlistPath,
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
 *
 * `unresolved` does fail, and `--allow-unresolved` is the only way past it
 * (`AS-COVER-003`). A partial understanding of a codebase that reports itself
 * as complete is the failure the whole static half exists to remove: `unreached`
 * is computed against the catalog, so a catalog with holes in it makes that
 * count a floor rather than an answer. Accepting the gap still prints it.
 */
export function coverageExitCode(
  report: CoverageReport,
  options: { allowUnresolved?: boolean } = {},
): number {
  if (report.unreached.length > 0) return 1;
  if (report.unmanifestedDomain.length > 0) return 1;
  // `report.unresolved` already excludes allowlisted entries, so the per-entry
  // ratchet and the blanket flag compose: the list holds the sites you have
  // accepted, and the flag is still there for a codebase not ready to enumerate
  // them. Both stale lists fail regardless of either — a ratchet that can rot
  // is a ratchet that stops meaning anything.
  if (report.unresolved.length > 0 && !options.allowUnresolved) return 1;
  if (report.staleAllowlist.length > 0) return 1;
  if (report.staleUnreadAllowlist.length > 0) return 1;
  return 0;
}
