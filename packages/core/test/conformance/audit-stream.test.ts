/**
 * Conformance: the console audit sink writes to the diagnostic stream, never to
 * stdout, so a host that renders its own output there is not corrupted by it
 * (docs/06 §audit). Requirement: AS-OBSV-002.
 *
 * This is a Node-behaviour test, not a style preference. `console.debug` is the
 * browser's verbose channel, but in Node it is an alias of `console.log` and
 * goes to stdout — which is how `agent-surface inspect --json` came to emit
 * unparseable output for any app that built its registry with
 * `environment: "development"` (see AS-CLI-004).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { consoleAuditSink, createAgentSurfaceRegistry } from "@agent-surface/core";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AS-OBSV-002 — audit diagnostics never reach stdout", () => {
  it("records on the diagnostic channel, not the one console.log writes to", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

    consoleAuditSink().record({ at: "2026-08-01T00:00:00.000Z", type: "registration" });

    // Under Node `console.debug` *is* `console.log`; asserting on both is what
    // makes this test fail if the sink regresses to either.
    expect(log).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toBe("[agent-surface audit]");
  });

  it("still records — the fix moves the stream, it does not silence the trail", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const registry = createAgentSurfaceRegistry({ environment: "development" });
    registry.register({ type: "audit.stream", description: "fixture", actions: {} });

    expect(error.mock.calls.some((call) => call[0] === "[agent-surface audit]")).toBe(true);
    registry.dispose();
  });
});
