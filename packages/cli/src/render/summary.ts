/**
 * The report model every renderer draws: labelled rows, tables, and findings.
 *
 * `init`, `inspect`, `snapshot` and `check` answer different questions, but they
 * answer them about the same surface and a reader moves between them. So the
 * *shapes* are shared — a run header, a status matrix, a findings section — and
 * only the content differs. A second copy of "how a finding looks" is how two
 * commands drift into disagreeing about what they found, and a second copy of
 * "how a block is laid out" is how one report ends up with two text columns.
 *
 * Everything here is data. A command builds [`ReportPart`s](#ReportPart) and
 * hands them to the presenter; plain text renders them in `plain.ts`, the
 * terminal UI in `ink.tsx`, and neither can invent a row the other does not
 * have.
 */
import { relative } from "node:path";
import type { ScenarioFailure } from "../analysis.js";
import type { CollectResult } from "../collect.js";
import type { Depth } from "../contract.js";
import type { CoverageReport } from "../coverage.js";
import { unreadKey } from "../coverage.js";
import { authoredIds, unresolved, type CapabilityInventory } from "../extract.js";
import type { CapabilityRow, SurfaceView } from "./model.js";

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
  rows?: TableRow[];
  lines?: string[];
  hint?: string;
}

/** A grid row. `note` is prose too long for a cell, printed under the row. */
export interface TableRow {
  cells: string[];
  note?: string;
}

/**
 * Which stream a part belongs on (`AS-CLI-004`). `out` is the command's answer;
 * `err` is everything a reader needs *about* the answer — what failed, what is
 * missing, what to run next — so a redirected `--json` or a captured report
 * still carries it.
 */
export type ReportStream = "out" | "err";

/**
 * One piece of a report, as data.
 *
 * A command emits a sequence of these and never touches a renderer, which is
 * the whole point: the choice between the terminal UI and plain text is made
 * once, for the run, instead of at each of thirty call sites where three of them
 * will be forgotten. Before this existed, `check` had no terminal UI at all,
 * `snapshot` had no header, and `inspect` printed its static catalog as raw
 * text in the middle of a rendered one.
 */
export type ReportPart = { stream?: ReportStream } & (
  | { kind: "blocks"; blocks: ReportBlock[] }
  | { kind: "table"; title: string; lead?: string; headers: string[]; rows: TableRow[] }
  | { kind: "findings"; sections: FindingSection[] }
  | { kind: "surface"; view: SurfaceView; detail?: boolean }
  /** `muted` is an aside — a closing hint, never something the report turns on. */
  | { kind: "note"; title?: string; lines: string[]; muted?: boolean }
  | { kind: "steps"; title: string; steps: string[] }
);

/**
 * Where a report's text column starts, for every block in every command.
 *
 * Fixed rather than derived per block, so the `Coverage`/`Baselines` matrix in
 * `check`, the `Config`/`Depth` header above it and the `Capabilities` row of a
 * catalog all line up as one grid. A block that indents itself differently
 * reads as a different kind of thing — which is exactly what happened while
 * each renderer sized its own label column from whatever rows it happened to be
 * handed.
 *
 * Wide enough for every label this package prints; `reportGrid` still widens
 * for a longer one rather than crushing it, and the presenter keeps that width
 * for the rest of the report so the grid can only ever grow once.
 */
export const LABEL_WIDTH = 14;
export const STATUS_WIDTH = 7;

/**
 * What a command is waiting for, in the words every command uses for it.
 *
 * The TypeScript program is read synchronously and the app loads after it —
 * seconds on a real repository, and a terminal showing nothing for them looks
 * wedged. `mountingLabel` names which scenario and how much is left, because a
 * spinner that only spins cannot be told apart from one that is stuck.
 */
export const READING_SOURCE = "reading the source";

export function mountingLabel(scenarios: string[], index: number): string {
  const position = scenarios.length > 1 ? ` (${index + 1} of ${scenarios.length})` : "";
  return `mounting ${scenarios[index]}${position}`;
}

/** The column widths a set of blocks needs, never narrower than the shared grid. */
export function reportGrid(
  blocks: ReportBlock[],
  minimum = LABEL_WIDTH,
): { label: number; statuses: boolean } {
  return {
    label: Math.max(minimum, ...blocks.flatMap((b) => b.rows.map((row) => row.label.length + 2))),
    statuses: blocks.some((block) => block.rows.some((row) => row.status)),
  };
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

function componentOf(capabilityId: string): string {
  const path = capabilityId.replace(/^(view|domain):/, "");
  const dot = path.lastIndexOf(".");
  return dot === -1 ? path : path.slice(0, dot);
}

export interface CatalogDetailOptions {
  /** Show the raw call-site table, origins, notes and diagnostic prose. */
  detail?: boolean;
}

/**
 * The catalog *below* its summary: which component authors what, and every call
 * site the extractor could not read.
 *
 * Only `--depth static` prints this. At `--depth full` the scenario tables name
 * every capability a scenario reached, the `UNREACHED` section names the ones it
 * did not, and the verdict carries the unread call sites — so printing it here
 * would be the same information a second time, above the answer instead of in it.
 */
export function catalogDetailParts(
  inventory: CapabilityInventory,
  options: CatalogDetailOptions = {},
): ReportPart[] {
  const parts: ReportPart[] = [];
  const resolved = inventory.capabilities.filter((c) => c.resolution !== "unresolved");
  const unreadEntries = unresolved(inventory);

  const components = new Map<string, { ids: Set<string>; sites: number; partial: number }>();
  for (const capability of resolved) {
    const component = componentOf(capability.capabilityId);
    const current = components.get(component) ?? { ids: new Set<string>(), sites: 0, partial: 0 };
    current.ids.add(capability.capabilityId);
    current.sites += 1;
    if (capability.resolution === "partial") current.partial += 1;
    components.set(component, current);
  }

  if (components.size > 0) {
    parts.push({
      kind: "table",
      title: `COMPONENTS  (${components.size})`,
      headers: ["COMPONENT", "CAPABILITIES", "CALL SITES", "DYNAMIC META"],
      rows: [...components.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([component, data]) => ({
          cells: [
            `view:${component}`,
            String(data.ids.size),
            String(data.sites),
            data.partial > 0 ? String(data.partial) : NONE,
          ],
          note: [...data.ids].sort().join(" · "),
        })),
    });
  }

  if (unreadEntries.length > 0) {
    const groups = new Map<string, number>();
    for (const entry of unreadEntries) {
      const key = `${entry.origin.file}\0${entry.reason ?? "unknown"}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    parts.push({
      kind: "table",
      title: `UNREAD SITES  (${unreadEntries.length})`,
      lead: "Counts above are a floor until these sites are resolved or explicitly accepted.",
      headers: ["FILE", "REASON", "SITES"],
      rows: [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, count]) => {
          const [file, reason] = key.split("\0");
          return { cells: [file ?? "?", reason ?? "unknown", String(count)] };
        }),
    });
    // Spelled out, and never wrapped: the key is `file#reason#site` where the
    // site is a hash rather than the line the reader is looking at, so it is
    // copied, not typed.
    parts.push({
      kind: "note",
      title: "ALLOWLIST KEYS",
      lines: unreadEntries.map((entry) => `  allowlist key: ${unreadKey(entry)}`),
    });
  }

  if (options.detail) {
    const byId = [...resolved].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
    if (byId.length > 0) {
      parts.push({
        kind: "table",
        title: `CAPABILITY DETAILS  (${byId.length} call sites)`,
        headers: ["CAPABILITY", "KIND", "ORIGIN", "READ"],
        rows: byId.map((capability) => ({
          cells: [
            capability.capabilityId,
            capability.kind,
            `${capability.origin.file}:${capability.origin.line}`,
            capability.resolution,
          ],
          ...(capability.note ? { note: capability.note } : {}),
        })),
      });
    }
    if (unreadEntries.length > 0) {
      parts.push({ kind: "findings", sections: [unreadSection(unreadEntries)] });
    }
  } else if (unreadEntries.length > 0 || resolved.length > 0) {
    // The keys are above, in full: promising them behind a flag that has
    // already been satisfied is how a reader learns to distrust the footer.
    parts.push({
      kind: "note",
      muted: true,
      lines: ["Details: re-run with --detail for origins, per-site notes, and diagnostics."],
    });
  }
  return parts;
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
): { headers: string[]; rows: TableRow[] } {
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

export interface CheckOverview {
  status: "PASS" | "FAIL" | "ERROR";
  coverage?: CoverageReport;
  unresolvedAllowed: boolean;
  baselineCurrent: number;
  baselineTotal: number;
  scenarioManifestOk: boolean;
  rejected: number;
  mountFailures: number;
  /** What the run was pointed at. Printed above the matrix (`AS-CLI-007`). */
  context?: RunContext;
  /** Per-scenario totals, one row each — including the ones that threw. */
  stats: ScenarioStats[];
}

/** The health matrix: one row per class of finding, whether or not it fired. */
function checkMatrixRows(input: CheckOverview): ReportRow[] {
  const rows: ReportRow[] = [];
  const coverage = input.coverage;

  if (coverage) {
    rows.push({
      label: "Coverage",
      status:
        coverage.unreached.length > 0 || coverage.staleAllowlist.length > 0
          ? "FAIL"
          : coverage.allowed.length > 0
            ? "WARN"
            : "PASS",
      text:
        `${coverage.reached}/${coverage.authored} authored capabilities reached` +
        (coverage.unreached.length > 0 ? ` · ${coverage.unreached.length} unreached` : "") +
        (coverage.allowed.length > 0 ? ` · ${coverage.allowed.length} unreached allowlisted` : "") +
        (coverage.staleAllowlist.length > 0
          ? ` · ${coverage.staleAllowlist.length} stale allowlist entr${
              coverage.staleAllowlist.length === 1 ? "y" : "ies"
            }`
          : ""),
    });

    const unread = coverage.unresolved.length;
    const accepted = coverage.allowedUnread.length;
    rows.push({
      label: "Catalog",
      status:
        coverage.staleUnreadAllowlist.length > 0 || (unread > 0 && !input.unresolvedAllowed)
          ? "FAIL"
          : unread > 0 || accepted > 0
            ? "WARN"
            : "PASS",
      text:
        coverage.staleUnreadAllowlist.length > 0
          ? `${coverage.staleUnreadAllowlist.length} stale unread allowlist entr${
              coverage.staleUnreadAllowlist.length === 1 ? "y" : "ies"
            }`
          : unread > 0
            ? `${unread} unread static site${unread === 1 ? "" : "s"}${
                input.unresolvedAllowed ? " accepted by --allow-unresolved" : ""
              }`
            : accepted > 0
              ? `${accepted} unread static site${accepted === 1 ? "" : "s"} allowlisted`
              : "all static sites resolved",
    });

    rows.push({
      label: "Domain",
      status:
        coverage.unmanifestedDomain.length > 0
          ? "FAIL"
          : coverage.domainAuthoritative
            ? "PASS"
            : "WARN",
      text:
        coverage.unmanifestedDomain.length > 0
          ? `${coverage.unmanifestedDomain.length} mounted capabilit${
              coverage.unmanifestedDomain.length === 1 ? "y" : "ies"
            } absent from manifest`
          : coverage.domainAuthoritative
            ? `${coverage.domainReached.length} manifest capabilit${
                coverage.domainReached.length === 1 ? "y" : "ies"
              } reached`
            : "authoritative manifest not configured",
    });
  } else {
    rows.push({
      label: "Coverage",
      status: input.status === "ERROR" ? "ERROR" : "WARN",
      text:
        input.status === "ERROR"
          ? "no verdict; runtime analysis incomplete"
          : "not evaluated — statement about these scenarios only; re-run with --depth full",
    });
  }

  const baselineOk = input.baselineCurrent === input.baselineTotal && input.scenarioManifestOk;
  rows.push({
    label: "Baselines",
    status: baselineOk ? "PASS" : "FAIL",
    text:
      `${input.baselineCurrent}/${input.baselineTotal} scenario baselines current` +
      (input.scenarioManifestOk ? "" : " · scenario manifest differs"),
  });

  const mounted = input.stats.filter((entry) => !entry.failed).length;
  rows.push({
    label: "Runtime",
    status: input.mountFailures > 0 ? "ERROR" : input.rejected > 0 ? "FAIL" : "PASS",
    text:
      input.mountFailures > 0
        ? `${input.mountFailures} scenario${input.mountFailures === 1 ? "" : "s"} did not mount`
        : input.rejected > 0
          ? `${input.rejected} registration${input.rejected === 1 ? "" : "s"} rejected`
          : `${mounted} scenario${mounted === 1 ? "" : "s"} mounted`,
  });

  return rows;
}

/** `check`'s first screen: the verdict, what it was computed over, then health. */
export function checkOverviewParts(input: CheckOverview): ReportPart[] {
  const table = scenarioTable(input.stats, { baselines: true });
  return [
    {
      kind: "blocks",
      blocks: [
        {
          title: `SURFACE CHECK  ${input.status}`,
          rows: input.context ? runContextRows(input.context) : [],
        },
        { rows: checkMatrixRows(input) },
      ],
    },
    {
      kind: "table",
      title: `SCENARIOS  (${input.stats.length})`,
      headers: table.headers,
      rows: table.rows,
    },
  ];
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
 * A scenario the config declares whose mount threw.
 *
 * A finding like any other, and it has to look like one: this is the class that
 * invalidates every count in the report, so a reader must not have to notice
 * that it was printed in a different style from the findings above it.
 */
export function failureSection(failures: ScenarioFailure[]): FindingSection {
  return {
    title: "DID NOT MOUNT",
    gloss: "these scenarios threw, and were skipped",
    count: failures.length,
    lines: failures.flatMap((failure) => [failure.scenario, `    ${failure.message}`]),
  };
}

/**
 * Why there is no coverage verdict. Never silence: a reader who asked for the
 * complete answer and got a partial one has to be told which part is missing,
 * or the partial one reads as the complete one.
 *
 * The failures themselves are listed directly above by `failureSection`. This
 * says what their absence costs the rest of the report, and nothing else.
 */
export function noVerdictSection(failures: ScenarioFailure[]): FindingSection {
  return {
    title: "NO COVERAGE VERDICT",
    gloss: "a scenario did not mount, so nothing reached anything",
    count: failures.length,
    lines: [
      "Every capability those scenarios would have surfaced would be reported unreached,",
      "so no verdict is printed at all. Fix the mount, or name a scenario that works.",
    ],
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
