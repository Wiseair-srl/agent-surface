/**
 * Public API closure (AS-CLOSURE-001…004).
 *
 * The inventory is derived from the built `.d.ts` of every subpath in every
 * published `exports` map — not from a hand-written list — so a new export
 * cannot enter the public API without appearing here. The classification in
 * `spec/api-surface.json` supplies intent; the conformance manifest supplies
 * the proof. A boundary that can create, expose or invoke a capability must
 * name the requirement that proves it needs an authority.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

/** Classes whose exports must declare `requires` and cite conformance. */
export const PROVING_CLASSES = new Set([
  "authority-boundary",
  "capability-construction",
  "execution-boundary",
  "exposure-boundary",
]);

/** Published entry points, keyed by "<package>" or "<package>/<subpath>". */
export function publishedEntries(root) {
  const entries = [];
  for (const dir of readdirSync(join(root, "packages")).sort()) {
    const packagePath = join(root, "packages", dir, "package.json");
    if (!existsSync(packagePath)) continue;
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    if (pkg.private || !pkg.exports) continue;
    for (const [subpath, condition] of Object.entries(pkg.exports)) {
      const types = typeof condition === "object" ? condition.types : undefined;
      entries.push({
        id: subpath === "." ? pkg.name : `${pkg.name}${subpath.slice(1)}`,
        package: pkg.name,
        subpath,
        types: types ? resolve(join(root, "packages", dir), types) : undefined,
      });
    }
  }
  return entries;
}

/**
 * Every symbol reachable through a published subpath, with value/type kind.
 *
 * Memoized per root: building one TypeScript program per entry point costs
 * seconds, and both the CI script and the conformance suite ask more than
 * once within a single process. Each process still starts cold, so the gate
 * never reports a stale inventory.
 */
const inventoryCache = new Map();

export function buildInventory(root) {
  const cached = inventoryCache.get(root);
  if (cached) return cached;
  const result = computeInventory(root);
  inventoryCache.set(root, result);
  return result;
}

function computeInventory(root) {
  const inventory = {};
  const missing = [];
  for (const entry of publishedEntries(root)) {
    if (!entry.types || !existsSync(entry.types)) {
      missing.push(entry.id);
      continue;
    }
    const program = ts.createProgram([entry.types], { skipLibCheck: true });
    const checker = program.getTypeChecker();
    const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(entry.types));
    const symbols = {};
    for (const raw of checker.getExportsOfModule(moduleSymbol)) {
      const symbol = raw.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(raw) : raw;
      const isValue = Boolean(
        symbol.flags &
          (ts.SymbolFlags.Function |
            ts.SymbolFlags.Variable |
            ts.SymbolFlags.Class |
            ts.SymbolFlags.Enum |
            ts.SymbolFlags.BlockScopedVariable),
      );
      symbols[raw.getName()] = isValue ? "value" : "type";
    }
    inventory[entry.id] = symbols;
  }
  return { inventory, missing };
}

/**
 * Compare the derived inventory against the classification manifest.
 * Returns a flat list of human-readable problems; empty means closed.
 */
export function checkClosure(root) {
  const problems = [];
  const manifestPath = join(root, "spec/api-surface.json");
  if (!existsSync(manifestPath)) return ["spec/api-surface.json not found"];
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const requirements = JSON.parse(readFileSync(join(root, "spec/conformance.json"), "utf8")).requirements ?? {};

  const { inventory, missing } = buildInventory(root);
  for (const id of missing) {
    problems.push(`${id}: declaration file not built — run "pnpm build" before the closure gate`);
  }

  const declaredModules = new Set(Object.keys(manifest.modules ?? {}));
  for (const id of Object.keys(inventory)) {
    if (!declaredModules.has(id)) {
      problems.push(`${id}: published entry point is absent from spec/api-surface.json`);
    }
  }
  for (const id of declaredModules) {
    if (!(id in inventory) && !missing.includes(id)) {
      problems.push(`${id}: classified entry point is no longer published`);
    }
  }

  for (const [id, symbols] of Object.entries(inventory)) {
    const declared = manifest.modules?.[id];
    if (!declared) continue;
    for (const [name, kind] of Object.entries(symbols)) {
      const entry = declared[name];
      if (!entry) {
        problems.push(
          `${id}#${name}: new public export is unclassified — add it to spec/api-surface.json with a class`,
        );
        continue;
      }
      if (entry.kind !== kind) {
        problems.push(`${id}#${name}: classified as ${entry.kind}, built as ${kind}`);
      }
      if (!manifest.classes?.[entry.class]) {
        problems.push(`${id}#${name}: unknown class "${entry.class}"`);
        continue;
      }
      if (kind === "type" && entry.class !== "type") {
        problems.push(`${id}#${name}: type-only export must use class "type"`);
      }
      if (kind === "value" && entry.class === "type") {
        problems.push(`${id}#${name}: value export cannot use class "type"`);
      }
      if (!PROVING_CLASSES.has(entry.class)) continue;

      if (!entry.requires) {
        problems.push(`${id}#${name}: class "${entry.class}" must declare how it requires an authority`);
      } else if (!manifest.requires?.[entry.requires]) {
        problems.push(`${id}#${name}: unknown requires mode "${entry.requires}"`);
      }
      const cited = entry.conformance ?? [];
      if (cited.length === 0) {
        problems.push(`${id}#${name}: class "${entry.class}" must cite at least one conformance requirement`);
      }
      for (const requirement of cited) {
        const found = requirements[requirement];
        if (!found) {
          problems.push(`${id}#${name}: cites unknown requirement ${requirement}`);
        } else if (found.status !== "implemented") {
          problems.push(`${id}#${name}: cites ${requirement}, whose status is "${found.status}"`);
        }
      }
    }
    for (const name of Object.keys(declared)) {
      if (!(name in symbols)) {
        problems.push(`${id}#${name}: classified export no longer exists — remove it from spec/api-surface.json`);
      }
    }
  }
  return problems;
}
