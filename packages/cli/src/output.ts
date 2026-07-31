import type { ReactElement } from "react";

export interface OutputFlags {
  plain?: boolean;
  json?: boolean;
}

/**
 * Terminal-aware only when there is a terminal. Piped output, `--plain`, `CI`
 * and `NO_COLOR` all fall back to plain text — a CLI whose output changes shape
 * when redirected is unusable in a build log.
 */
export function isPlain(flags: OutputFlags): boolean {
  if (flags.json) return true;
  if (flags.plain) return true;
  if (process.env["CI"]) return true;
  if (process.env["NO_COLOR"]) return true;
  if (process.stdout.isTTY !== true) return true;
  // A TTY that cannot report its width (some CI ptys, `script` on macOS) makes
  // Ink lay out at zero columns and emit one character per line. Plain text is
  // the only honest rendering for a terminal whose size is unknown.
  return !process.stdout.columns;
}

export function write(text: string): void {
  process.stdout.write(`${text}\n`);
}

export function writeError(text: string): void {
  process.stderr.write(`${text}\n`);
}

type InkModule = typeof import("./render/ink.js");

let cached: InkModule | null | undefined;

/**
 * Loads the Ink renderer, or returns `null` when it cannot run here.
 *
 * Two reasons this is lazy rather than a top-level import. It keeps `--plain`
 * and `--json` from paying for a terminal UI they never draw — and Ink drives
 * React through `react-reconciler`, which reads React 19 internals, so a host
 * that pins React 18 globally cannot load it at all. Neither is a reason to
 * fail a command that was about to print text.
 */
export async function loadInk(): Promise<InkModule | null> {
  if (cached !== undefined) return cached;
  try {
    cached = await import("./render/ink.js");
  } catch {
    cached = null;
  }
  return cached;
}

/** Paints an Ink element once and returns when the frame has been flushed. */
export async function paint(element: ReactElement): Promise<void> {
  const { render } = await import("ink");
  const instance = render(element);
  instance.unmount();
  await instance.waitUntilExit();
}

/** A live Ink frame (spinner) that is cleared before the real output lands. */
export async function transient(element: ReactElement): Promise<() => void> {
  const { render } = await import("ink");
  const instance = render(element);
  return () => {
    instance.clear();
    instance.unmount();
  };
}
