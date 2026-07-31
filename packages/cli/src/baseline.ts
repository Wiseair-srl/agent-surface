import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { serializeSurfaceSnapshot } from "@agent-surface/testing";
import type { AgentSurfaceSnapshot } from "@agent-surface/core";

export const DEFAULT_BASELINE_DIR = ".agent-surface";

export function baselineDirFor(configPath: string, configured?: string): string {
  return resolve(dirname(configPath), configured ?? DEFAULT_BASELINE_DIR);
}

export function baselinePath(dir: string, scenario: string): string {
  return join(dir, `${scenario}.json`);
}

/**
 * The committed form. `serializeSurfaceSnapshot` is the same normalizer the
 * Vitest matcher uses: registration ids become stable placeholders and the
 * volatile fields (surfaceId, capturedAt, version) drop out, so a baseline
 * diff is a diff of *what agents can see* and nothing else.
 */
export function normalize(snapshot: AgentSurfaceSnapshot): unknown {
  return serializeSurfaceSnapshot(snapshot);
}

export function readBaseline(path: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export function writeBaseline(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export interface DiffEntry {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
  /**
   * The capability the change belongs to. A reviewer needs to know that
   * `view:devices.table.sort` changed — `components[3].actions[1]` is the same
   * fact in a form nobody can act on.
   */
  subject?: string;
}

const PATH_SEGMENT = /([^.[\]]+)|\[(\d+)\]/g;

/** Nearest enclosing capability id for a diff path, if the path sits inside one. */
function subjectFor(document: unknown, path: string): string | undefined {
  let node: unknown = document;
  let subject: string | undefined;
  for (const match of path.matchAll(PATH_SEGMENT)) {
    if (typeof node !== "object" || node === null) return subject;
    const record = node as Record<string, unknown>;
    const candidate = record["capabilityId"] ?? record["procedureId"];
    if (typeof candidate === "string") subject = candidate;
    const key = match[1] ?? match[2];
    if (key === undefined) return subject;
    node = record[key];
  }
  if (typeof node === "object" && node !== null) {
    const record = node as Record<string, unknown>;
    const candidate = record["capabilityId"] ?? record["procedureId"];
    if (typeof candidate === "string") subject = candidate;
  }
  return subject;
}

/** Labels each entry with the capability it belongs to, when there is one. */
export function annotate(entries: DiffEntry[], after: unknown, before: unknown): DiffEntry[] {
  return entries.map((entry) => {
    const subject = subjectFor(after, entry.path) ?? subjectFor(before, entry.path);
    return subject ? { ...entry, subject } : entry;
  });
}

/**
 * Structural diff, deliberately total: every difference is drift, including a
 * changed description. Descriptions are the provider's cached prompt prefix
 * (D28) — a silent edit re-bills every conversation, so it is exactly the kind
 * of change a reviewer should see.
 */
export function diff(before: unknown, after: unknown, path = ""): DiffEntry[] {
  if (Object.is(before, after)) return [];

  const bothArrays = Array.isArray(before) && Array.isArray(after);
  const bothObjects =
    !bothArrays &&
    typeof before === "object" &&
    typeof after === "object" &&
    before !== null &&
    after !== null;

  if (bothArrays) {
    const entries: DiffEntry[] = [];
    const max = Math.max(before.length, after.length);
    for (let i = 0; i < max; i++) {
      const at = `${path}[${i}]`;
      if (i >= before.length) entries.push({ path: at, kind: "added", after: after[i] });
      else if (i >= after.length) entries.push({ path: at, kind: "removed", before: before[i] });
      else entries.push(...diff(before[i], after[i], at));
    }
    return entries;
  }

  if (bothObjects) {
    const entries: DiffEntry[] = [];
    const beforeRecord = before as Record<string, unknown>;
    const afterRecord = after as Record<string, unknown>;
    const keys = new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)]);
    for (const key of [...keys].sort()) {
      const at = path ? `${path}.${key}` : key;
      if (!(key in beforeRecord)) {
        entries.push({ path: at, kind: "added", after: afterRecord[key] });
      } else if (!(key in afterRecord)) {
        entries.push({ path: at, kind: "removed", before: beforeRecord[key] });
      } else {
        entries.push(...diff(beforeRecord[key], afterRecord[key], at));
      }
    }
    return entries;
  }

  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  return [{ path: path || "<root>", kind: "changed", before, after }];
}

export function formatValue(value: unknown): string {
  if (value === undefined) return "—";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}
