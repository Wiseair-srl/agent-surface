import { JSDOM } from "jsdom";

/**
 * A presentation surface only exists once components mount, and mounting needs
 * a DOM. Vitest gets one from its `jsdom` environment; a plain Node process has
 * to install one itself — *before* anything imports `react-dom`, which reads
 * these globals at module scope.
 *
 * Process-wide on purpose, and permanent: the app tree runs inside the
 * vite-node graph, which shares this realm's globals, and there is deliberately
 * no way to take the DOM back down — see the note on teardown below. Returning
 * nothing is the honest signature; an installer that handed back a disposer
 * doing nothing would read, at every call site, as cleanup that happens.
 */
export function installDom(url = "http://localhost/"): void {
  const globals = globalThis as Record<string, unknown>;
  if (typeof globals["document"] !== "undefined") return;

  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url,
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // Everything jsdom's window defines that this realm does not already have.
  // Skipping existing keys matters: Node's own `fetch`, `URL` and timers are
  // more capable than jsdom's shims, and clobbering them breaks app code.
  for (const key of Object.getOwnPropertyNames(window)) {
    if (key.startsWith("_")) continue;
    if (key in globals) continue;
    const descriptor = Object.getOwnPropertyDescriptor(window, key);
    if (!descriptor) continue;
    Object.defineProperty(globals, key, descriptor);
  }

  for (const key of ["window", "document", "navigator"] as const) {
    if (!(key in globals)) {
      Object.defineProperty(globals, key, { value: window[key], configurable: true });
    }
  }
}

/**
 * There is deliberately no teardown, and the DOM is deliberately process-wide.
 *
 * `react-dom` captures `window`/`document` when it is first imported. Removing
 * the globals — or worse, calling `window.close()` — leaves that captured
 * reference pointing at a dead realm, so the *next* mount in the same process
 * fails in a way that looks nothing like its cause. A CLI invocation ends by
 * exiting (see `exitWhenWedged` in `bin.ts`), so there is nothing to reclaim; only
 * in-process callers (the test suite) run more than one command, and those are
 * exactly the ones this protects.
 */
