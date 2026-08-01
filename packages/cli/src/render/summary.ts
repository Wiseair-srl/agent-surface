/**
 * The report model both renderers draw: labelled rows, and findings.
 *
 * `inspect` and `check` answer different questions, but they answer them about
 * the same surface and a reader moves between them. So the *shapes* are shared
 * — a run header, a status matrix, a findings section — and only the content
 * differs. A second copy of "how a finding looks" is how the two commands drift
 * into disagreeing about what they found.
 *
 * Everything here is data. Plain text renders it in `plain.ts`, the terminal UI
 * in `ink.tsx`, and neither can invent a row the other does not have.
 */
import { relative } from "node:path";
import type { CollectResult } from "../collect.js";
import type { Depth } from "../contract.js";
import type { CoverageReport } from "../coverage.js";
import { unreadKey } from "../coverage.js";
import { authoredIds, unresolved, type CapabilityInventory } from "../extract.js";
import type { CapabilityRow } from "./model.js";

export type ReportStatus = "PASS" | "WARN" | "FAIL" | "ERROR";

/** Colour hint for the terminal UI. Plain text ignores it — words carry it. */
export type ReportTone = "good" | "warn" | "bad";

/** One `label  [STATUS]  text` line. */
export interface ReportRow {
  label: string;
  status?: ReportStatus;
  tone?: ReportTone;
  text: string;
}

export interface ReportBlock {
  title?: string;
  rows: ReportRow[];
}

/**
 * A finding: a heading that says what it is, a gloss that says why it matters,
 * and its entries as either a table or a list. `hint` is what to do about it,
 * printed with the finding rather than left for the reader to infer.
 */
export interface FindingSection {
  title: string;
  gloss: string;
  count: number;
  /** `notice` is reported but gates nothing — rendered without alarm. */
  tone?: "finding" | "notice";
  headers?: string[];
  rows?: Array<{ cells: string[]; note?: string }>;
  lines?: string[];
  hint?: string;
}

/**
 * A path as the reader will type it. `relative` alone turns a baseline
 * directory outside the working tree into a stack of `..` nobody can read, let
 * alone paste — so anything that escapes the working directory prints absolute.
 */
export function displayPath(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith("..") ? rel : path;
}

const DEPTH_TEXT: Record<Depth, string> = {
  full: "full — the source is read and every scenario is mounted",
  static: "static — the source only; nothing is mounted",
  runtime: "runtime — the scenarios only; the source is not read",
};

export interface RunContext {
  configPath: string;
  depth: Depth;
  /** The effective scope: `--scope` when given, else the config's. */
  scope?: string[];
  /** Scenarios this run covers. Absent when the depth mounts nothing. */
  scenarios?: string[];
  /** Every scenario the config declares, for `n of m` when one was named. */
  declaredScenarios?: string[];
}

/**
 * What the numbers below are about, before there are any (`AS-CLI-007`).
 *
 * A report that opens with its counts asks the reader to hold them until the
 * qualifier arrives — and on a scoped run, or a run against a config they did
 * not choose, the unqualified number is simply the wrong one.
 */
export function runContextRows(context: RunContext): ReportRow[] {
  const rows: ReportRow[] = [
    { label: "Config", text: displayPath(context.configPath) },
    { label: "Depth", text: DEPTH_TEXT[context.depth] },
    {
      label: "Scope",
      text:
        context.scope && context.scope.length > 0
          ? `${context.scope.join(" · ")} — every count below is relative to it`
          : "whole surface — no component-type prefix filter",
    },
  ];
  if (context.scenarios) {
    const declared = context.declaredScenarios ?? context.scenarios;
    const named = context.scenarios.length < declared.length;
    rows.push({
      label: "Scenarios",
      text:
        `${named ? `${context.scenarios.length} of ${declared.length}` : context.scenarios.length}` +
        ` — ${context.scenarios.join(", ")}`,
    });
  }
  return rows;
}

/**
 * The static catalog's summary (`AS-COVER-001…003`). "Upper bound" is in the
 * text on purpose: a tsconfig's include globs are wider than what a bundle
 * reaches, so a capability in a component no route renders any more is counted
 * here. That is dead code — a different finding, not a false positive — and the
 * reader has to be told which number they are holding.
 */
export function catalogRows(
  inventory: CapabilityInventory,
  options: { domainCapabilities?: number; mounted?: boolean } = {},
): ReportRow[] {
  const resolved = inventory.capabilities.filter((c) => c.resolution !== "unresolved");
  const unreadEntries = unresolved(inventory);
  const dynamicMetadata = resolved.filter((c) => c.resolution === "partial").length;
  const authored = authoredIds(inventory).size + (options.domainCapabilities ?? 0);

  return [
    {
      label: "STATUS",
      tone: unreadEntries.length > 0 ? "warn" : "good",
      text:
        unreadEntries.length > 0
          ? `INCOMPLETE — ${unreadEntries.length} unread capability identit${
              unreadEntries.length === 1 ? "y" : "ies"
            }`
          : "COMPLETE — every capability identity resolved",
    },
    {
      label: "Capabilities",
      text: `${authored} authored (upper bound) · ${resolved.length} resolved call site${
        resolved.length === 1 ? "" : "s"
      }`,
    },
    {
      label: "Program",
      text:
        `${inventory.filesAnalyzed} file${inventory.filesAnalyzed === 1 ? "" : "s"} analyzed` +
        (inventory.filesOutsideRoot > 0
          ? ` · ${inventory.filesOutsideRoot} agent-surface implementation file${
              inventory.filesOutsideRoot === 1 ? "" : "s"
            } excluded`
          : ""),
    },
    {
      label: "Metadata",
      text:
        `${dynamicMetadata} call site${dynamicMetadata === 1 ? "" : "s"} partially read` +
        (dynamicMetadata > 0 ? " · identity remains resolved" : ""),
    },
    {
      // Three different statements, and only one of them is a number. "Nobody
      // looked" and "there is nothing to look at" must not read alike (OQ-1).
      label: "Domain",
      ...(options.mounted && options.domainCapabilities === undefined
        ? { tone: "warn" as const }
        : {}),
      text:
        options.domainCapabilities !== undefined
          ? `${options.domainCapabilities} manifest capabilit${
              options.domainCapabilities === 1 ? "y" : "ies"
            }`
          : options.mounted
            ? "no authoritative oRPC manifest configured — that plane has no denominator"
            : "not analyzed at static depth; full depth reads the oRPC manifest",
    },
  ];
}

/**
 * The header a run opens with: what it was pointed at, and the catalog it read
 * before mounting anything.
 */
export function runHeaderBlocks(
  title: string,
  context: RunContext,
  inventory?: CapabilityInventory,
  domainCapabilities?: number,
): ReportBlock[] {
  return [
    { title, rows: runContextRows(context) },
    ...(inventory
      ? [
          {
            title: "STATIC CATALOG",
            rows: catalogRows(inventory, {
              ...(domainCapabilities === undefined ? {} : { domainCapabilities }),
              ...(context.depth === "static" ? {} : { mounted: true }),
            }),
          },
        ]
      : []),
  ];
}

/** Per-scenario totals — the row a reader compares scenarios across. */
export interface ScenarioStats {
  scenario: string;
  route?: string;
  callable: number;
  disabled: number;
  hidden: number;
  rejected: number;
  /** Set when the scenario threw instead of mounting. */
  failed?: boolean;
  /** Why it threw, printed under its row rather than in a column. */
  failure?: string;
  /** `check` only: how the committed baseline compared. */
  baseline?: string;
}

export function scenarioStats(result: CollectResult): ScenarioStats {
  const counts = { expose: 0, disable: 0, hide: 0 };
  for (const capability of result.explanation.capabilities) counts[capability.outcome] += 1;
  return {
    scenario: result.scenario,
    ...(result.snapshot.route?.path ? { route: result.snapshot.route.path } : {}),
    callable: counts.expose,
    disabled: counts.disable,
    hidden: counts.hide,
    rejected: result.rejections.length,
  };
}

const NONE = "—";

/** One row per scenario: the comparison a list of names cannot make. */
export function scenarioTable(
  stats: ScenarioStats[],
  options: { baselines?: boolean } = {},
): { headers: string[]; rows: Array<{ cells: string[] }> } {
  const headers = ["SCENARIO", "ROUTE", "CALLABLE", "DISABLED", "HIDDEN", "REJECTED"];
  if (options.baselines) headers.push("BASELINE");
  return {
    headers,
    rows: stats.map((entry) => ({
      // The baseline column already says `did not mount`, so the note carries
      // only what a reader cannot get anywhere else: why.
      ...(entry.failed
        ? {
            note: `${options.baselines ? "" : "did not mount — "}${
              entry.failure ?? "the scenario threw during mount"
            }`,
          }
        : {}),
      cells: [
        entry.scenario,
        entry.route ?? NONE,
        ...(entry.failed
          ? [NONE, NONE, NONE, NONE]
          : [
              String(entry.callable),
              String(entry.disabled),
              String(entry.hidden),
              entry.rejected > 0 ? String(entry.rejected) : NONE,
            ]),
        ...(options.baselines ? [entry.failed ? "did not mount" : (entry.baseline ?? NONE)] : []),
      ],
    })),
  };
}

/**
 * What every scenario together made of one capability.
 *
 * `unreached` answers "did anything mount this". This answers the question one
 * step in: *it mounted, and could any scenario actually call it?* A drawer
 * every scenario leaves closed registers its `close` action in every snapshot
 * and is callable in none of them — reached by the coverage join, and never
 * exercised. Neither half sees that alone.
 */
export interface CapabilityReach {
  capabilityId: string;
  /** The best outcome any scenario produced: expose beats disable beats hide. */
  best: "expose" | "disable" | "hide";
  effect?: string;
  flags: string[];
  /** Why it was not callable, from the scenario that came closest. */
  note?: string;
  scenarios: string[];
}

const RANK = { hide: 0, disable: 1, expose: 2 } as const;

export function trackReach(
  reach: Map<string, CapabilityReach>,
  rows: CapabilityRow[],
  scenario: string,
): void {
  for (const row of rows) {
    const current = reach.get(row.capabilityId);
    if (!current) {
      reach.set(row.capabilityId, {
        capabilityId: row.capabilityId,
        best: row.outcome,
        ...(row.effect ? { effect: row.effect } : {}),
        flags: row.flags,
        ...(row.reason ? { note: row.reason } : {}),
        scenarios: [scenario],
      });
      continue;
    }
    current.scenarios.push(scenario);
    // The effect is a property of the descriptor, so any scenario that carries
    // one carries the same one — but a policy-hidden row has no snapshot entry
    // to read it from, so the first scenario to see it wins.
    if (!current.effect && row.effect) current.effect = row.effect;
    if (current.flags.length === 0 && row.flags.length > 0) current.flags = row.flags;
    if (RANK[row.outcome] > RANK[current.best]) {
      current.best = row.outcome;
      if (row.reason) current.note = row.reason;
      else delete current.note;
    }
  }
}

export function neverCallable(reach: Map<string, CapabilityReach>): CapabilityReach[] {
  return [...reach.values()]
    .filter((entry) => entry.best !== "expose")
    .sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
}

const MUTATING = new Set(["server-mutation", "external-side-effect", "destructive"]);

interface Risk {
  present: number;
  destructive: number;
  mutating: number;
  confirmed: number;
  bound: number;
}

/**
 * What an agent could do here, as opposed to how much surface there is.
 *
 * Counted over everything the snapshot carries — `callable` *and*
 * `visible-disabled`. A disabled capability is disclosed to the agent and
 * becomes callable the moment the UI state it waits on arrives, so leaving it
 * out would report a surface with a destructive action on it as one without.
 * A hidden capability is genuinely absent: authority removed it, and counting
 * it here would report a policy working as a risk.
 */
function riskOf(
  entries: Array<{ outcome: "expose" | "disable" | "hide"; effect?: string; flags: string[] }>,
): Risk {
  const present = entries.filter((entry) => entry.outcome !== "hide");
  return {
    present: present.length,
    destructive: present.filter((entry) => entry.effect === "destructive").length,
    mutating: present.filter((entry) => entry.effect && MUTATING.has(entry.effect)).length,
    confirmed: present.filter((entry) =>
      entry.flags.some((flag) => flag.startsWith("confirmation:")),
    ).length,
    bound: present.filter((entry) => entry.flags.some((flag) => flag.includes(" bound"))).length,
  };
}

function riskParts(risk: Risk): string[] {
  return [
    ...(risk.destructive > 0 ? [`${risk.destructive} destructive`] : []),
    ...(risk.mutating > risk.destructive ? [`${risk.mutating - risk.destructive} mutating`] : []),
    ...(risk.confirmed > 0 ? [`${risk.confirmed} confirmation-gated`] : []),
  ];
}

/**
 * The scenario header's risk clause. Empty when there is nothing to say, so a
 * read-only surface does not carry a row of zeroes to be read and dismissed.
 */
export function riskClause(rows: CapabilityRow[]): string {
  const parts = riskParts(riskOf(rows));
  return parts.join(", ");
}

/** The same question over every scenario at once, for the closing summary. */
function riskText(reach: Map<string, CapabilityReach>): string {
  const risk = riskOf([...reach.values()].map((entry) => ({ ...entry, outcome: entry.best })));
  const parts = riskParts(risk);
  if (risk.present === 0) {
    return "nothing is on the surface at all — every capability was hidden by policy";
  }
  if (parts.length === 0) {
    return (
      `nothing mutating or destructive is on the surface · ${risk.present} ` +
      `read-only or local-state capabilit${risk.present === 1 ? "y" : "ies"}`
    );
  }
  return [...parts, ...(risk.bound > 0 ? [`${risk.bound} with bound input`] : [])].join(" · ");
}

export interface SurfaceSummaryInput {
  depth: Depth;
  coverage?: CoverageReport;
  scenarios: ScenarioStats[];
  failures: number;
  reach: Map<string, CapabilityReach>;
}

/**
 * `inspect`'s closing block — the thing a reader who scrolled to the bottom
 * stops on. It states no PASS/FAIL: `inspect` reports findings and never gates
 * on them, and a status word beside a number would read as the exit code it is
 * not.
 */
export function surfaceSummaryRows(input: SurfaceSummaryInput): ReportRow[] {
  const rows: ReportRow[] = [];
  const coverage = input.coverage;

  if (coverage) {
    rows.push({
      label: "Reach",
      tone: coverage.unreached.length > 0 ? "bad" : "good",
      text:
        `${coverage.reached}/${coverage.authored} authored capabilit${
          coverage.authored === 1 ? "y" : "ies"
        } reached` +
        (coverage.unreached.length > 0 ? ` · ${coverage.unreached.length} unreached` : "") +
        (coverage.allowed.length > 0 ? ` · ${coverage.allowed.length} allowlisted` : ""),
    });
  }

  const mounted = input.reach.size;
  const dark = neverCallable(input.reach);
  if (mounted > 0) {
    const stuck = dark.filter((entry) => entry.best === "disable").length;
    const why = [
      ...(stuck > 0 ? [`${stuck} disabled`] : []),
      ...(dark.length > stuck ? [`${dark.length - stuck} hidden`] : []),
    ].join(", ");
    rows.push({
      label: "Callable",
      tone: dark.length > 0 ? "warn" : "good",
      text:
        `${mounted - dark.length}/${mounted} mounted capabilit${
          mounted === 1 ? "y is" : "ies are"
        } callable in at least one scenario` +
        (dark.length > 0 ? ` · ${dark.length} never callable (${why})` : ""),
    });
    rows.push({ label: "Risk", text: riskText(input.reach) });
  }

  if (coverage) {
    if (coverage.domainReached.length > 0 || coverage.domainAuthoritative) {
      rows.push({
        label: "Domain",
        tone: coverage.unmanifestedDomain.length > 0 ? "bad" : "good",
        text:
          coverage.unmanifestedDomain.length > 0
            ? `${coverage.unmanifestedDomain.length} mounted capabilit${
                coverage.unmanifestedDomain.length === 1 ? "y is" : "ies are"
              } absent from the oRPC manifest`
            : `${coverage.domainReached.length} capabilit${
                coverage.domainReached.length === 1 ? "y" : "ies"
              } reached${
                coverage.domainAuthoritative
                  ? " against the authoritative oRPC manifest"
                  : " and held apart — configure the manifest to cover that plane"
              }`,
      });
    }
    rows.push({
      label: "Catalog",
      tone: coverage.unresolved.length > 0 ? "warn" : "good",
      text:
        coverage.unresolved.length > 0
          ? `${coverage.unresolved.length} unread call site${
              coverage.unresolved.length === 1 ? "" : "s"
            } — every count above is a floor`
          : `every call site read${
              coverage.allowedUnread.length > 0
                ? ` · ${coverage.allowedUnread.length} allowlisted`
                : ""
            }`,
    });
  }

  rows.push({
    label: "Scenarios",
    tone: input.failures > 0 ? "bad" : undefined,
    text:
      `${input.scenarios.filter((entry) => !entry.failed).length} mounted` +
      (input.failures > 0 ? ` · ${input.failures} did not mount` : ""),
  });

  rows.push({ label: "Verdict", tone: verdictTone(input), text: verdictText(input) });
  return rows;
}

function verdictTone(input: SurfaceSummaryInput): ReportTone {
  if (input.failures > 0) return "bad";
  if (!input.coverage) return "warn";
  const clean =
    input.coverage.unreached.length === 0 &&
    input.coverage.unresolved.length === 0 &&
    input.coverage.staleAllowlist.length === 0 &&
    input.coverage.staleUnreadAllowlist.length === 0 &&
    input.coverage.unmanifestedDomain.length === 0;
  return clean ? "good" : "bad";
}

/** The one sentence a reader takes away. Never a status word — see above. */
function verdictText(input: SurfaceSummaryInput): string {
  if (input.failures > 0) {
    return "a scenario did not mount, so no coverage verdict was computed at all";
  }
  const coverage = input.coverage;
  if (!coverage) {
    return input.depth === "runtime"
      ? "the source was not read at this depth — a statement about these scenarios only"
      : "no coverage verdict at this depth";
  }
  if (coverage.unreached.length > 0) {
    return `${coverage.unreached.length} authored capabilit${
      coverage.unreached.length === 1 ? "y is" : "ies are"
    } reached by no scenario`;
  }
  if (coverage.unresolved.length > 0) {
    return "every capability the catalog could read is reached — and the catalog has holes in it";
  }
  return coverage.allowed.length > 0
    ? "no new coverage gaps — the allowlist still holds the known ones"
    : "every authored capability is reached by a scenario";
}

/**
 * The findings a coverage report carries. Shared by `inspect`, `snapshot` and
 * `check`, so the gate and the viewer cannot describe the same gap differently.
 */
export function coverageSections(
  report: CoverageReport,
  options: { compact?: boolean; detail?: boolean } = {},
): FindingSection[] {
  const sections: FindingSection[] = [];

  if (report.unreached.length > 0) {
    sections.push({
      title: "UNREACHED",
      gloss: "authored, and no scenario mounts it",
      count: report.unreached.length,
      headers: ["CAPABILITY", "ORIGIN"],
      rows: report.unreached.map((entry) => ({
        cells: [entry.capabilityId, `${entry.origin.file}:${entry.origin.line}`],
      })),
      hint:
        "add a scenario that mounts them, delete the dead component, or record the decision " +
        `in ${displayPath(report.allowlistPath)}`,
    });
  }

  if (report.undeclared.length > 0) {
    if (!options.compact || options.detail) {
      sections.push({
        title: "UNDECLARED",
        gloss: "present at runtime with no static origin — a dynamic registration, or a gap here",
        count: report.undeclared.length,
        tone: "notice",
        lines: report.undeclared,
      });
    } else {
      sections.push({
        title: "NOTICE",
        gloss: `${report.undeclared.length} runtime capabilit${
          report.undeclared.length === 1 ? "y has" : "ies have"
        } no static origin; re-run with --detail to list them`,
        count: 0,
        tone: "notice",
      });
    }
  }

  if (report.unmanifestedDomain.length > 0) {
    sections.push({
      title: "UNMANIFESTED DOMAIN",
      gloss: "mounted, but absent from the authoritative oRPC manifest",
      count: report.unmanifestedDomain.length,
      lines: report.unmanifestedDomain,
      hint: "add them to the manifest, or stop mounting a router the manifest does not describe",
    });
  }

  if (report.staleAllowlist.length > 0) {
    sections.push({
      title: "STALE ALLOWLIST",
      gloss: "a scenario reaches these now, so delete them before the list rots",
      count: report.staleAllowlist.length,
      lines: report.staleAllowlist,
      hint: `delete these keys from ${displayPath(report.allowlistPath)}`,
    });
  }

  if (report.staleUnreadAllowlist.length > 0) {
    sections.push({
      title: "STALE UNREAD ALLOWLIST",
      gloss: "the extractor reads these now, so delete them before the list rots",
      count: report.staleUnreadAllowlist.length,
      lines: report.staleUnreadAllowlist,
      hint: `delete these keys from ${displayPath(report.unreadAllowlistPath)}`,
    });
  }

  if (report.unresolved.length > 0) {
    sections.push(unreadSection(report.unresolved, report.unreadAllowlistPath));
  }

  return sections;
}

/**
 * Call sites the extractor could not read. Reported with file and line, never
 * dropped: an inventory that silently omitted what it failed to parse would
 * understate the denominator, and every number built on it would claim a
 * completeness it never had.
 *
 * The allowlist key is spelled out because it is `file#reason#site` and the
 * site is a hash — not the line the reader is looking at — so leaving them to
 * infer it guarantees a wrong guess and an entry that never matches.
 */
export function unreadSection(
  entries: Array<Parameters<typeof unreadKey>[0]>,
  allowlistPath?: string,
): FindingSection {
  return {
    title: "UNREAD CALL SITES",
    gloss: "the catalog is incomplete, so every count above is a floor",
    count: entries.length,
    lines: entries.flatMap((entry) => [
      `${entry.origin.file}:${entry.origin.line}`,
      `    ${entry.note ?? "the extractor could not read this call site"}`,
      `    allowlist key: ${unreadKey(entry)}`,
    ]),
    hint: allowlistPath
      ? `make the call site readable, or accept each key in ${displayPath(allowlistPath)}`
      : "make the call site readable, or accept each key in .agent-surface/unresolved-allow.json",
  };
}

/**
 * Mounted, and callable in no scenario. A finding `inspect` reports and the
 * gate does not: unlike an unreached capability, this one *is* covered by a
 * scenario — what is missing is a scenario that puts the app in the state, or
 * under the authority, where it can be used. That is a judgement about the
 * scenarios rather than a defect in the surface.
 *
 * Worth printing only when more than one scenario ran. Over a single scenario
 * "never callable" is the same statement its own table already made, one line
 * per capability, and a report that says everything twice is read once.
 */
export function neverCallableSection(entries: CapabilityReach[]): FindingSection {
  const stuck = entries.filter((entry) => entry.best === "disable").length;
  const hidden = entries.length - stuck;
  return {
    title: "NEVER CALLABLE",
    gloss: "every scenario mounted these, and none of them could call one",
    count: entries.length,
    tone: "notice",
    headers: ["CAPABILITY", "BEST STATE", "WHY"],
    rows: entries.map((entry) => ({
      cells: [
        entry.capabilityId,
        entry.best === "disable" ? "disabled" : "hidden",
        entry.best === "disable"
          ? (entry.note ?? "the UI reported it unavailable in every scenario")
          : "a policy hid it in every scenario",
      ],
    })),
    hint: [
      ...(stuck > 0
        ? [
            "add a scenario that reaches the state these need — an open drawer, a filled list, " +
              "a selected row",
          ]
        : []),
      ...(hidden > 0
        ? [
            `add a scenario whose consumer carries the authority ${
              stuck > 0 ? "the hidden ones are" : "these are"
            } waiting for`,
          ]
        : []),
    ].join("; "),
  };
}
