/**
 * The presenter: one report, one look, whichever command produced it.
 *
 * Every human-facing command builds [`ReportPart`s](./summary.ts) and hands them
 * here. Nothing else in this package decides between the terminal UI and plain
 * text, waits on a spinner, or writes a blank line — which is the point. That
 * choice used to be made at each call site, so `check` and `snapshot` never drew
 * a terminal UI at all, `inspect` printed its static catalog and its mount
 * failures as raw text in the middle of a rendered report, and the same block
 * carried a different text column in each of them.
 *
 * Three invariants it exists to keep:
 *
 * - **One renderer per stream, decided once.** Ink when that stream is a
 *   terminal, plain text otherwise (`AS-CLI-003`), for every part of the run.
 * - **One blank line between parts**, on both paths. Ink ends each painted frame
 *   with a newline and plain text has to be asked for one, so the callers stop
 *   sprinkling `\n` and getting it wrong in one of the two.
 * - **One label grid.** The text column belongs to the report, not to the block,
 *   and it can only ever widen — so `Config`, `Capabilities` and `Coverage` line
 *   up whether they were printed a second or a minute apart.
 */
import { isPlain, loadInk, paint, transient, write, type OutputFlags } from "../output.js";
import { renderPartPlain } from "./plain.js";
import { LABEL_WIDTH, reportGrid, type ReportPart, type ReportStream } from "./summary.js";

export interface Presenter {
  /** Draws parts in order, one blank line between them. */
  emit(...parts: ReportPart[]): Promise<void>;
  /** Names the slow thing currently happening. A no-op in plain mode. */
  wait(label: string): Promise<void>;
  /** Clears any spinner. Called for you before anything is drawn. */
  settle(): void;
}

type InkModule = NonNullable<Awaited<ReturnType<typeof loadInk>>>;

class ReportPresenter implements Presenter {
  /** `null` on a stream rendering plain text — piped, CI, `--plain`, React 18. */
  readonly #out: InkModule | null;
  readonly #err: InkModule | null;
  /** Sticky, and only ever wider: a grid that shrank mid-report is two grids. */
  #labelWidth = LABEL_WIDTH;
  #wrote = false;
  /**
   * Whether the last part was written as plain text. Ink's own frame supplies
   * the blank line after it; plain text has to be asked for one before the next
   * part. Tracking which drew last is what keeps the spacing identical when a
   * drawn report sends a finding to a redirected stderr.
   */
  #plainLast = false;
  #stop: (() => void) | undefined;

  constructor(out: InkModule | null, err: InkModule | null) {
    this.#out = out;
    this.#err = err;
  }

  async emit(...parts: ReportPart[]): Promise<void> {
    for (const part of parts) await this.#draw(part);
  }

  async wait(label: string): Promise<void> {
    this.settle();
    // Nothing transient is ever written in plain mode: `AS-CLI-003` wants
    // byte-stable output, and a spinner is neither.
    const ink = this.#out;
    if (ink) this.#stop = await transient(<ink.Loading label={label} />);
  }

  settle(): void {
    this.#stop?.();
    this.#stop = undefined;
  }

  async #draw(part: ReportPart): Promise<void> {
    // A spinner is a live frame: anything written under it lands in the region
    // Ink is about to erase.
    this.settle();
    const stream: ReportStream = part.stream ?? "out";
    if (part.kind === "blocks") {
      this.#labelWidth = Math.max(this.#labelWidth, reportGrid(part.blocks, LABEL_WIDTH).label);
    }
    const separate = this.#wrote && this.#plainLast;
    const ink = stream === "err" ? this.#err : this.#out;

    if (ink) {
      if (separate) write("", stream);
      await paint(<ink.Part part={part} labelWidth={this.#labelWidth} />, stream);
    } else {
      const text = renderPartPlain(part, this.#labelWidth);
      if (text.length === 0) return;
      write(separate ? `\n${text}` : text, stream);
    }
    this.#plainLast = ink === null;
    this.#wrote = true;
  }
}

/**
 * The presenter for this run.
 *
 * `--json` resolves to the plain path and its spinner to nothing, so a command
 * emitting data rather than a report simply has no parts to emit — it never has
 * to ask which renderer it is talking to.
 */
export async function createPresenter(flags: OutputFlags): Promise<Presenter> {
  const drawn = !isPlain(flags, "out") || !isPlain(flags, "err");
  // `null` when Ink cannot run here (React 18 host), which is a fallback to
  // plain text rather than a failed command — see loadInk().
  const ink = drawn ? await loadInk() : null;
  return new ReportPresenter(
    ink && !isPlain(flags, "out") ? ink : null,
    ink && !isPlain(flags, "err") ? ink : null,
  );
}
