import { basename, relative } from "node:path";
import type { CollectResult } from "./collect.js";
import type { CoverageReport } from "./coverage.js";
import type { CapabilityInventory } from "./extract.js";
import { normalize } from "./baseline.js";
import { buildView, flatRows, type CapabilityRow } from "./render/model.js";

/** Stable, complete per-scenario document shared by JSON, baselines and check. */
export interface ScenarioReport {
  scenario: string;
  scope?: string[];
  snapshot: unknown;
  capabilities: CapabilityRow[];
  rejections: CollectResult["rejections"];
  explanation?: { capabilities: CapabilityRow[] };
}

export function scenarioReport(
  result: CollectResult,
  options: { attribution?: boolean; schemas?: boolean } = {},
): ScenarioReport {
  const view = buildView(result, {
    ...(options.attribution ? { explain: true } : {}),
    ...(options.schemas ? { schemas: true } : {}),
  });
  const capabilities = flatRows(view);
  return {
    scenario: result.scenario,
    ...(result.scope ? { scope: result.scope } : {}),
    snapshot: normalize(result.snapshot),
    // Includes expose, disable and hide. Rows never contain runtime ids.
    capabilities,
    rejections: [...result.rejections].sort(
      (a, b) =>
        a.componentType.localeCompare(b.componentType) ||
        a.instanceId.localeCompare(b.instanceId) ||
        a.reason.localeCompare(b.reason),
    ),
    ...(options.attribution ? { explanation: { capabilities } } : {}),
  };
}

/** Baseline payload: same semantic document, without invocation-only labels. */
export function scenarioBaseline(result: CollectResult): Record<string, unknown> {
  const report = scenarioReport(result);
  return {
    ...(report.snapshot as Record<string, unknown>),
    capabilities: report.capabilities,
    rejections: report.rejections,
  };
}

/** Machine output must not contain checkout-specific absolute paths. */
export function inventoryReport(
  inventory: CapabilityInventory | undefined,
  domainCapabilities?: string[],
): unknown {
  if (!inventory) return null;
  return {
    ...inventory,
    root: ".",
    tsconfig: relative(inventory.root, inventory.tsconfig) || "tsconfig.json",
    ...(domainCapabilities
      ? { domain: { source: "manifest", capabilities: [...domainCapabilities].sort() } }
      : {}),
  };
}

export function coverageReport(report: CoverageReport | undefined): unknown {
  if (!report) return null;
  return {
    ...report,
    allowlistPath: basename(report.allowlistPath),
    unreadAllowlistPath: basename(report.unreadAllowlistPath),
  };
}
