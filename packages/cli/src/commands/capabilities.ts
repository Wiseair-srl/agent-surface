import { dirname } from "node:path";
import { extractCapabilities, unresolved } from "../extract.js";
import { renderInventoryPlain } from "../render/plain.js";
import { write, writeError } from "../output.js";

export interface CapabilitiesOptions {
  configPath: string;
  tsconfig?: string;
  json?: boolean;
  allowUnresolved?: boolean;
}

/**
 * The static inventory: what this codebase *authors*, as opposed to what a
 * scenario happens to mount. No Vite dev server, no jsdom, no scenarios, no
 * mount — it reads the TypeScript program and nothing else.
 *
 * The non-zero exit on an unresolved call site is the load-bearing part
 * (`AS-COVER-003`). A partial understanding of the codebase that reports itself
 * as complete is the exact failure this command exists to remove: every number
 * downstream — the coverage denominator above all — is only as trustworthy as
 * the extractor's own admission of what it could not read.
 */
export async function runCapabilities(options: CapabilitiesOptions): Promise<number> {
  const inventory = extractCapabilities({
    root: dirname(options.configPath),
    ...(options.tsconfig ? { tsconfig: options.tsconfig } : {}),
  });
  const unresolvedEntries = unresolved(inventory);

  if (options.json) {
    write(JSON.stringify(inventory, null, 2));
  } else {
    write(renderInventoryPlain(inventory));
  }

  if (unresolvedEntries.length === 0) return 0;
  if (options.allowUnresolved) return 0;
  if (!options.json) {
    writeError(
      "\nexiting 1 because the inventory is incomplete — pass --allow-unresolved to accept it",
    );
  }
  return 1;
}
