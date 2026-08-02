#!/usr/bin/env node
/**
 * Gate 1 — public API closure.
 *
 * Fails CI when the public API and spec/api-surface.json disagree: a new
 * export without a classification, a classified export that vanished, a
 * kind mismatch, or a create/expose/invoke boundary that does not cite an
 * implemented conformance requirement for how it requires an authority.
 *
 * Run after "pnpm build" — the inventory is derived from the built .d.ts.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkClosure } from "./lib/api-closure.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = checkClosure(root);

if (problems.length > 0) {
  console.error(`public API closure: ${problems.length} problem(s)\n`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error("\nspec/api-surface.json is the classification manifest.");
  process.exit(1);
}
console.log("public API closure: every published export is classified and proven");
