// Conformance: AS-ID-001 (grammar accept/reject), AS-ID-002 (wire codec + truncation)
import { describe, expect, it } from "vitest";
import {
  decodeWireName,
  encodeWireName,
  isValidCapabilityName,
  isValidComponentType,
  isValidInstanceId,
  parseCapabilityId,
} from "@agent-surface/core";

describe("id grammar (docs/01)", () => {
  it("accepts valid component types", () => {
    for (const type of ["devices", "devices.table", "app.navigation", "x-ray.sub-panel", "a1.b2"]) {
      expect(isValidComponentType(type), type).toBe(true);
    }
  });

  it("rejects invalid component types", () => {
    for (const type of [
      "",
      "Devices",
      "devices.Table",
      "devices..table",
      ".devices",
      "devices.",
      "devices_table",
      "1devices",
      "-devices",
      "devices.tab_le",
    ]) {
      expect(isValidComponentType(type), type).toBe(false);
    }
  });

  it("accepts camelCase capability names and rejects dots/underscores", () => {
    expect(isValidCapabilityName("selectRows")).toBe(true);
    expect(isValidCapabilityName("read")).toBe(true);
    expect(isValidCapabilityName("goTo2")).toBe(true);
    expect(isValidCapabilityName("SelectRows")).toBe(false);
    expect(isValidCapabilityName("select.rows")).toBe(false);
    expect(isValidCapabilityName("select_rows")).toBe(false);
    expect(isValidCapabilityName("")).toBe(false);
  });

  it("accepts instance ids with letters/digits/-/_", () => {
    expect(isValidInstanceId("default")).toBe(true);
    expect(isValidInstanceId("main")).toBe(true);
    expect(isValidInstanceId("dev_42")).toBe(true);
    expect(isValidInstanceId("A-1_b")).toBe(true);
    expect(isValidInstanceId("")).toBe(false);
    expect(isValidInstanceId("a.b")).toBe(false);
  });

  it("parses view ids: capability name is everything after the last dot", () => {
    expect(parseCapabilityId("view:devices.table.selectRows")).toEqual({
      plane: "view",
      componentType: "devices.table",
      name: "selectRows",
    });
    expect(parseCapabilityId("view:app.navigation.goTo")).toEqual({
      plane: "view",
      componentType: "app.navigation",
      name: "goTo",
    });
  });

  it("treats domain paths as opaque", () => {
    expect(parseCapabilityId("domain:devices.disable")).toEqual({
      plane: "domain",
      path: "devices.disable",
    });
  });

  it("rejects garbage ids", () => {
    for (const id of ["", "devices.table.selectRows", "view:", "view:selectRows", "other:devices.x", "view:Devices.table.selectRows"]) {
      expect(parseCapabilityId(id), id).toBeUndefined();
    }
  });
});

describe("wire-name codec (docs/09)", () => {
  it("round-trips the docs example", () => {
    expect(encodeWireName("view:devices.table.selectRows")).toBe("view_devices__table__selectRows");
    expect(decodeWireName("view_devices__table__selectRows")).toBe("view:devices.table.selectRows");
  });

  it("round-trips ids with hyphens and domain ids", () => {
    for (const id of [
      "view:devices.table.selectRows",
      "view:app.navigation.goTo",
      "view:x-ray.sub-panel.readState",
      "domain:devices.disable",
    ]) {
      expect(decodeWireName(encodeWireName(id))).toBe(id);
      expect(/^[a-zA-Z0-9_-]+$/.test(encodeWireName(id))).toBe(true);
    }
  });

  it("disambiguates per instance with an _at_ suffix (unique provider names)", async () => {
    const { encodeWireNameForInstance } = await import("@agent-surface/core");
    expect(encodeWireNameForInstance("view:devices.table.readState", "main")).toBe(
      "view_devices__table__readState_at_main",
    );
    expect(encodeWireNameForInstance("view:devices.table.readState")).toBe(
      "view_devices__table__readState",
    );
    const a = encodeWireNameForInstance(`view:${"seg.".repeat(14)}x.cap`, "main");
    const b = encodeWireNameForInstance(`view:${"seg.".repeat(14)}x.cap`, "comparison");
    expect(a.length).toBeLessThanOrEqual(64);
    expect(b.length).toBeLessThanOrEqual(64);
    expect(a).not.toBe(b); // hash covers the instance too
  });

  it("truncates long names to 56 + '_' + 7-char hash (64 total)", () => {
    const longType = `${"verylongsegment.".repeat(4)}tail`;
    const id = `view:${longType}.someCapabilityName`;
    const name = encodeWireName(id);
    expect(name.length).toBe(64);
    expect(name.slice(56, 57)).toBe("_");
    // Deterministic and distinct from a different long id.
    expect(encodeWireName(id)).toBe(name);
    expect(encodeWireName(`${id}X`)).not.toBe(name);
  });
});
