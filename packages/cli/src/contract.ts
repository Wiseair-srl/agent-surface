/**
 * The vocabulary every layer shares, and nothing else.
 *
 * It is its own module because `bin.ts` needs both of these before it has
 * decided which command to run, and everything else in this package pulls in
 * either the TypeScript compiler or Vite the moment it is imported. A `--help`
 * that boots a TypeScript program to print a paragraph is a `--help` nobody
 * runs twice.
 */

export const DEPTHS = ["static", "runtime", "full"] as const;

/**
 * How much of the surface a command is asked to compute.
 *
 * A presentation surface has two sources of truth and every command needs some
 * mix of both — the **catalog** this codebase authors, which is static, and the
 * **projection** a mounted scenario surfaces, which is not. Splitting those
 * across separate commands is what let a green `check` sit on top of a route no
 * scenario visits, so the split lives here instead.
 *
 * `static` reads the TypeScript program and mounts nothing — no Vite server, no
 * jsdom, no scenarios. It is the only depth that survives an app which will not
 * mount, and the only one that needs no scenarios to exist yet.
 *
 * `runtime` mounts and skips the program read, for a repository whose tsconfig
 * is wide enough that booting it costs more than the answer is worth.
 *
 * `full` does both and joins them, which is the only depth that can answer
 * *did we author something no scenario reaches*. It is the default because a
 * tool that has to be asked for the complete answer mostly gives the
 * incomplete one.
 */
export type Depth = (typeof DEPTHS)[number];

export function isDepth(value: unknown): value is Depth {
  return typeof value === "string" && (DEPTHS as readonly string[]).includes(value);
}

/**
 * The caller asked for something impossible — as opposed to the app being
 * broken, which is what a mount failure is. Both exit `2`: CI has to tell "the
 * surface changed" apart from "the tool never ran", and these are both the
 * second one.
 */
export class UsageError extends Error {}
