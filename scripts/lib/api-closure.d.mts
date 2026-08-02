export interface PublishedEntry {
  /** "<package>" or "<package>/<subpath>". */
  id: string;
  package: string;
  subpath: string;
  /** Absolute path to the built declaration file, when the subpath declares one. */
  types: string | undefined;
}

export interface Inventory {
  /** entry id → symbol name → whether the symbol carries a runtime value. */
  inventory: Record<string, Record<string, "value" | "type">>;
  /** Entry ids whose declaration file has not been built. */
  missing: string[];
}

/** Classes whose exports must declare `requires` and cite conformance. */
export declare const PROVING_CLASSES: ReadonlySet<string>;

export declare function publishedEntries(root: string): PublishedEntry[];
export declare function buildInventory(root: string): Inventory;
export declare function checkClosure(root: string): string[];
