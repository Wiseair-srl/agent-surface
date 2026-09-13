// Conformance: AS-HOST-001, AS-HOST-002, AS-HOST-003 (D43).
import { describe, expect, it, vi } from "vitest";
import { createAgentSurfaceRegistry } from "../src/index.js";
import { createBrowserSurfaceSession, type BrowserSurfaceCall, type BrowserSurfaceIdentity } from "../src/host.js";
import { devicesTableDefinition, makeDevicesState } from "./helpers.js";

const identity: BrowserSurfaceIdentity = { appId: "console", buildId: "build-1", sessionId: "session-1", tabId: "tab-1" };

function setup(options?: { maxEntries?: number; ttlMs?: number; now?: () => number }) {
  const registry = createAgentSurfaceRegistry();
  const state = makeDevicesState();
  const registration = registry.register(devicesTableDefinition(state));
  const session = createBrowserSurfaceSession({ registry, identity, ...options });
  const announcement = session.connect("connection-1");
  const call: BrowserSurfaceCall = {
    protocolVersion: 1, type: "surface-call", identity, connectionId: announcement.connectionId,
    runId: "run-1", toolCallId: "tool-1",
    invocation: {
      invocationId: "invocation-1", capabilityId: "view:devices.table.selectRows",
      registrationId: registration.registrationId, surfaceVersion: announcement.snapshot.surfaceVersion,
      input: { ids: ["d1"] },
    },
  };
  return { registry, state, registration, session, call };
}

describe("browser host session", () => {
  it("AS-HOST-001: rejects malformed wire data and incomplete session identity", async () => {
    const { session, registry, call } = setup();
    expect(() => createBrowserSurfaceSession({ registry, identity: {} as BrowserSurfaceIdentity })).toThrow(/identity/);
    const invoke = vi.spyOn(registry, "invoke");
    for (const raw of [null, undefined, [], 42, {}, { ...call, invocation: null }, { ...call, runId: 42 }, { ...call, toolCallId: "x".repeat(513) }]) {
      expect((await session.invoke(raw as BrowserSurfaceCall)).result).toEqual({ status: "rejected", reason: "invalid-call" });
    }
    expect(invoke).not.toHaveBeenCalled();
    session.dispose(); registry.dispose();
  });
  it("AS-HOST-001: dispatches only the registered capability through the authorized registry", async () => {
    const { session, call, state, registry } = setup();
    const invoke = vi.spyOn(registry, "invoke");
    const result = await session.invoke(call);
    expect(result).toMatchObject({ type: "surface-result", identity, connectionId: call.connectionId, runId: call.runId, toolCallId: call.toolCallId, invocationId: "invocation-1", result: { status: "ok" } });
    expect(state.selectedIds).toEqual(["d1"]);
    expect(invoke).toHaveBeenCalledWith(call.invocation, expect.objectContaining({ consumer: { id: identity.sessionId, kind: "embedded" } }));
    session.dispose(); registry.dispose();
  });

  it("AS-HOST-001: rejects a wrong tab/build/session or connection before invoking", async () => {
    const { session, call, registry } = setup();
    const invoke = vi.spyOn(registry, "invoke");
    for (const key of ["appId", "buildId", "sessionId", "tabId"] as const) {
      expect((await session.invoke({ ...call, identity: { ...identity, [key]: "other" } })).result).toEqual({ status: "rejected", reason: "wrong-session" });
    }
    expect((await session.invoke({ ...call, connectionId: "other" })).result).toEqual({ status: "rejected", reason: "disconnected" });
    expect(invoke).not.toHaveBeenCalled();
    session.dispose(); registry.dispose();
  });

  it("AS-HOST-001: rejects stale revisions and registrations, including reads", async () => {
    const { session, call, registration, registry } = setup();
    const invoke = vi.spyOn(registry, "invoke");
    expect((await session.invoke({ ...call, invocation: { ...call.invocation, registrationId: "wrong" } })).result).toEqual({ status: "rejected", reason: "stale-surface" });
    registration.invalidate();
    expect((await session.invoke({ ...call, invocation: { ...call.invocation, capabilityId: "view:devices.table.readState" } })).result).toEqual({ status: "rejected", reason: "stale-surface" });
    expect(invoke).not.toHaveBeenCalled();
    session.dispose(); registry.dispose();
  });

  it("AS-HOST-002: duplicate requests join once; changed input/run/tool identity conflicts", async () => {
    const { session, call, registry } = setup();
    const invoke = vi.spyOn(registry, "invoke");
    const results = await Promise.all([session.invoke(call), session.invoke(structuredClone(call))]);
    expect(results[0]).toEqual(results[1]);
    expect(invoke).toHaveBeenCalledTimes(1);
    for (const changed of [
      { ...call, runId: "other" }, { ...call, toolCallId: "other" },
      { ...call, invocation: { ...call.invocation, input: { ids: ["d2"] } } },
    ]) expect((await session.invoke(changed)).result).toEqual({ status: "rejected", reason: "invocation-conflict" });
    session.dispose(); registry.dispose();
  });

  it("AS-HOST-002: fake clock expires the entire session without re-executing old calls", async () => {
    let now = 0;
    const { session, call, registry } = setup({ now: () => now, ttlMs: 100, maxEntries: 1 });
    const invoke = vi.spyOn(registry, "invoke");
    await session.invoke(call);
    expect((await session.invoke({ ...call, invocation: { ...call.invocation, invocationId: "new" } })).result).toEqual({ status: "rejected", reason: "capacity-exceeded" });
    expect((await session.invoke(call)).result.status).toBe("ok");
    now = 100;
    expect((await session.invoke(call)).result).toEqual({ status: "rejected", reason: "session-expired" });
    expect(session.announcement()).toBeNull();
    expect(() => session.connect("connection-2")).toThrow(/expired/);
    expect(invoke).toHaveBeenCalledTimes(1);
    session.dispose(); registry.dispose();
  });

  it("AS-HOST-003: reconnect never transfers a pending mutation or old call identity", async () => {
    const { session, call, registry } = setup();
    await session.invoke(call);
    session.disconnect();
    expect((await session.invoke(call)).result).toEqual({ status: "rejected", reason: "disconnected" });
    expect(() => session.connect("connection-1")).toThrow(/reused/);
    session.connect("connection-2");
    expect((await session.invoke(call)).result).toEqual({ status: "rejected", reason: "disconnected" });
    expect((await session.invoke({ ...call, connectionId: "connection-2" })).result).toEqual({ status: "rejected", reason: "invocation-conflict" });
    session.dispose(); registry.dispose();
  });

  it("AS-HOST-003: a disconnect or revision change before dispatch prevents the effect", async () => {
    const { session, call, registry, registration, state } = setup();
    const pending = session.invoke(call);
    registration.invalidate();
    expect((await pending).result).toEqual({ status: "rejected", reason: "stale-surface" });
    const pending2 = session.invoke({ ...call, invocation: { ...call.invocation, invocationId: "new", surfaceVersion: registry.getVersion() } });
    session.disconnect();
    expect((await pending2).result).toEqual({ status: "rejected", reason: "disconnected" });
    expect(state.selectedIds).toEqual([]);
    session.dispose(); registry.dispose();
  });

  it("AS-HOST-003: pushes refreshed snapshots on navigation and removes disconnected tools", async () => {
    const { session, registration, registry } = setup();
    await Promise.resolve();
    const listener = vi.fn();
    session.subscribe(listener);
    registration.invalidate();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].snapshot.surfaceVersion).toBe(registry.getVersion());
    session.disconnect();
    registration.invalidate();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(session.announcement()).toBeNull();
    session.dispose(); registry.dispose();
  });
});
