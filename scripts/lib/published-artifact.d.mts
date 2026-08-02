/** Identifiers that must never reach a published artifact. */
export declare const FORBIDDEN_SEAM_SYMBOLS: readonly string[];

/** Identifiers that may exist internally but must never be exported. */
export declare const INTERNAL_ONLY_SYMBOLS: readonly string[];

/**
 * Inspect one packed package directory (the `package/` root of a tarball).
 * Returns human-readable problems; empty means the artifact is closed.
 */
export declare function inspectPackedPackage(packageDir: string): string[];
