import type { CapabilityContractEntry, CapabilityContractManifest } from "@agent-surface/core";

export type ChangeClassification = "widening" | "narrowing" | "neutral";
export type ChangeKind = "added" | "removed" | "changed";

export interface ContractChange {
  declarationId: string;
  capabilityId: string;
  kind: ChangeKind;
  field: string;
  classification: ChangeClassification;
  before?: unknown;
  after?: unknown;
}

const RISK: Record<string, number> = {
  read: 0,
  "local-state": 1,
  navigation: 2,
  "server-query": 3,
  "server-mutation": 4,
  "external-side-effect": 5,
  destructive: 6,
};

const CONFIRMATION: Record<string, number> = { never: 0, optional: 1, required: 2 };

function key(entry: CapabilityContractEntry): string {
  return `${entry.declarationId}\0${entry.capabilityId}`;
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function stringSet(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.map((item) => JSON.stringify(item)) : []);
}

function setDirection(before: unknown, after: unknown): "added" | "removed" | "mixed" | "same" {
  const a = stringSet(before);
  const b = stringSet(after);
  const added = [...b].some((item) => !a.has(item));
  const removed = [...a].some((item) => !b.has(item));
  if (added && removed) return "mixed";
  if (added) return "added";
  if (removed) return "removed";
  return "same";
}

function classify(field: string, before: unknown, after: unknown): ChangeClassification {
  if (field === "targets") {
    const direction = setDirection(before, after);
    return direction === "added" ? "widening" : direction === "removed" ? "narrowing" : "neutral";
  }
  if (field === "policies") {
    const direction = setDirection(before, after);
    return direction === "removed" || direction === "mixed"
      ? "widening"
      : direction === "added"
        ? "narrowing"
        : "neutral";
  }
  if (field === "confirmation") {
    const a = CONFIRMATION[String(before ?? "never")] ?? 0;
    const b = CONFIRMATION[String(after ?? "never")] ?? 0;
    return b < a ? "widening" : b > a ? "narrowing" : "neutral";
  }
  if (field === "effect") {
    const a = RISK[String(before)] ?? 0;
    const b = RISK[String(after)] ?? 0;
    // Lowering declared risk weakens review/approval posture.
    return b < a ? "widening" : b > a ? "narrowing" : "neutral";
  }
  return "neutral";
}

export function diffContracts(
  before: CapabilityContractManifest | undefined,
  after: CapabilityContractManifest,
): ContractChange[] {
  if (!before) {
    return after.capabilities.map((entry) => ({
      declarationId: entry.declarationId,
      capabilityId: entry.capabilityId,
      kind: "added",
      field: "capability",
      classification: "widening",
      after: entry,
    }));
  }
  const left = new Map(before.capabilities.map((entry) => [key(entry), entry]));
  const right = new Map(after.capabilities.map((entry) => [key(entry), entry]));
  const changes: ContractChange[] = [];
  for (const entryKey of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const a = left.get(entryKey);
    const b = right.get(entryKey);
    if (!a && b) {
      changes.push({
        declarationId: b.declarationId,
        capabilityId: b.capabilityId,
        kind: "added",
        field: "capability",
        classification: "widening",
        after: b,
      });
      continue;
    }
    if (a && !b) {
      changes.push({
        declarationId: a.declarationId,
        capabilityId: a.capabilityId,
        kind: "removed",
        field: "capability",
        classification: "narrowing",
        before: a,
      });
      continue;
    }
    if (!a || !b) continue;
    const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
    fields.delete("declarationId");
    fields.delete("capabilityId");
    fields.delete("contractHash");
    for (const field of [...fields].sort()) {
      const beforeValue = (a as unknown as Record<string, unknown>)[field];
      const afterValue = (b as unknown as Record<string, unknown>)[field];
      if (equal(beforeValue, afterValue)) continue;
      changes.push({
        declarationId: b.declarationId,
        capabilityId: b.capabilityId,
        kind: "changed",
        field,
        classification: classify(field, beforeValue, afterValue),
        before: beforeValue,
        after: afterValue,
      });
    }
  }
  return changes;
}

export function changeCounts(changes: readonly ContractChange[]): Record<ChangeClassification, number> {
  return {
    widening: changes.filter((change) => change.classification === "widening").length,
    narrowing: changes.filter((change) => change.classification === "narrowing").length,
    neutral: changes.filter((change) => change.classification === "neutral").length,
  };
}
