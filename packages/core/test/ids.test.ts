// Conformance: AS-ID-001 (grammar accept/reject), AS-ID-002 (wire codec +
// shortening), AS-WIRE-004 (64-char budget), AS-WIRE-007 (decode refuses what
// it cannot reverse — the map is authoritative)
import { describe, expect, it } from "vitest";
import {
  decodeWireName,
  encodeWireName,
  encodeWireNameForInstance,
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

  it("rejects a non-string id instead of throwing", () => {
    // The signature says `string`; this is the boundary where that assumption
    // is load-bearing. A caller relaying a malformed request must get a
    // grammar rejection (→ CAPABILITY_NOT_FOUND), not a TypeError the
    // invocation pipeline reports as an internal defect with retry:"no".
    for (const id of [undefined, null, 42, {}, ["view:devices.table.selectRows"]]) {
      expect(() => parseCapabilityId(id as never)).not.toThrow();
      expect(parseCapabilityId(id as never), String(id)).toBeUndefined();
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

  it("shortens long names to 54 + '_0_' + 7-char hash (64 total)", () => {
    const longType = `${"verylongsegment.".repeat(4)}tail`;
    const id = `view:${longType}.someCapabilityName`;
    const name = encodeWireName(id);
    expect(name.length).toBe(64);
    expect(name.slice(54, 57)).toBe("_0_");
    // Deterministic and distinct from a different long id.
    expect(encodeWireName(id)).toBe(name);
    expect(encodeWireName(`${id}X`)).not.toBe(name);
    // The marker is what lets decode refuse instead of guessing (D30).
    expect(decodeWireName(name)).toBeUndefined();
  });

  it("refuses to decode anything it cannot re-encode byte-identically", () => {
    // Per-instance names look decodable and are not: 0.1 answered
    // "view:devices.table.readState_at_main" here.
    expect(decodeWireName("view_devices__table__readState_at_main")).toBeUndefined();
    for (const name of ["", "_", "view", "view_", "other_devices__table__x", "_view_x"]) {
      expect(decodeWireName(name), name).toBeUndefined();
    }
  });

  it("AS-ID-004: a segment named 'at' or '0' decodes like any other", () => {
    // `view:at.a.a` encodes to `view_at__a__a`, which *contains* "_at_" — the
    // plane separator meeting the segment. Screening for the marker text
    // refused every such id its own faithful encoding; the property suite
    // found this one (seed 654467906, shrunk to "view:at.a.a").
    for (const id of [
      "view:at.a.a",
      "view:devices.at.readState",
      "view:at.at.at",
      "domain:a.0.b",
      "domain:0.at",
    ]) {
      expect(decodeWireName(encodeWireName(id)), id).toBe(id);
    }
    expect(encodeWireName("view:at.a.a")).toBe("view_at__a__a");
  });

  it("AS-WIRE-007: an id carrying its own '_' is hashed, not encoded faithfully", () => {
    // Only reachable on the opaque `domain:` plane. `domain:readState__0` and
    // `domain:readState.0` would otherwise share `domain_readState__0`, and no
    // decoder can separate them — so the ambiguous one takes the hashed path.
    const ambiguous = encodeWireName("domain:readState__0");
    expect(ambiguous).not.toBe(encodeWireName("domain:readState.0"));
    expect(ambiguous).toContain("_0_");
    expect(decodeWireName(ambiguous)).toBeUndefined();
    expect(decodeWireName(encodeWireName("domain:readState.0"))).toBe("domain:readState.0");
    // …and the per-instance form of such an id stays undecodable too, rather
    // than answering with a clean-looking path that is not the capability's.
    expect(decodeWireName(encodeWireNameForInstance("domain:at__at_", "_x0a"))).toBeUndefined();
  });

  it("AS-WIRE-007: refuses names whose underscore runs cannot come from a '.'", () => {
    // Hand-built names reach this function too — including ones an older
    // release emitted. A run of 3+ is ambiguous: `domain_at____x__a` is the
    // faithful encoding of BOTH `domain:at_._x.a` and `domain:at..x.a`.
    expect(decodeWireName("domain_at____x__a")).toBeUndefined();
    // Same collision, empty-segment shape.
    expect(decodeWireName("domain_at__at__")).toBeUndefined();
    expect(decodeWireName("domain___at__")).toBeUndefined();
  });
});
