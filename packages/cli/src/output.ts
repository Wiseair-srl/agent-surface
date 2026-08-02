import type { ReactElement } from "react";
import type { ReportStream } from "./render/summary.js";

export interface OutputFlags {
  plain?: boolean;
  json?: boolean;
}

function streamFor(stream: ReportStream): NodeJS.WriteStream {
  return stream === "err" ? process.stderr : process.stdout;
}

/**
 * Terminal-aware only when there is a terminal — and asked *per stream*, because
 * the two are redirected independently. `agent-surface check 2> report.txt` on a
 * terminal is a run whose answer is drawn and whose findings are a file, and a
 * file full of cursor escapes is a file nobody can read.
 *
 * `--plain`, `--json`, `CI` and `NO_COLOR` force plain on both: a CLI whose
 * output changes shape when redirected is unusable in a build log.
 */
export function isPlain(flags: OutputFlags, stream: ReportStream = "out"): boolean {
  if (flags.json) return true;
  if (flags.plain) return true;
  if (process.env["CI"]) return true;
  if (process.env["NO_COLOR"]) return true;
  const target = streamFor(stream);
  if (target.isTTY !== true) return true;
  // A TTY that cannot report its width (some CI ptys, `script` on macOS) makes
  // Ink lay out at zero columns and emit one character per line. Plain text is
  // the only honest rendering for a terminal whose size is unknown.
  return !target.columns;
}

export function write(text: string, stream: ReportStream = "out"): void {
  streamFor(stream).write(`${text}\n`);
}

export function writeError(text: string): void {
  write(text, "err");
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

/** Paints an Ink element once, onto one stream, and waits for the flush. */
export async function paint(element: ReactElement, stream: ReportStream = "out"): Promise<void> {
  const { render } = await import("ink");
  const instance = render(element, { stdout: streamFor(stream) });
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
