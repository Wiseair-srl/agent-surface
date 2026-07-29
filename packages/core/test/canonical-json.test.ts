/**
 * Canonical JSON encoding + FNV-1a fingerprint hash (D21/D22, docs/18).
 * Requirement: AS-CONFIRM-002 (encoding half; evidence matching is covered
 * in test/conformance/confirmation-binding.test.ts).
 */
import { describe, expect, it } from "vitest";
import { canonicalJson, fnv1a64 } from "../src/utils.js";

describe("canonicalJson", () => {
  it("is stable under object key insertion order, at every depth", () => {
    const a = { b: 1, a: { y: [1, 2], x: "s" } };
    const b = { a: { x: "s", y: [1, 2] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"x":"s","y":[1,2]},"b":1}');
  });

  it("keeps array order significant", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("omits undefined properties and encodes undefined array slots as null", () => {
    expect(canonicalJson({ a: 1, gone: undefined as never })).toBe('{"a":1}');
    expect(canonicalJson([1, undefined as never, 3])).toBe("[1,null,3]");
  });

  it("normalizes -0 to 0 and rejects non-finite numbers", () => {
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson({ n: -0 })).toBe(canonicalJson({ n: 0 }));
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/);
  });

  it("encodes primitives and null exactly like JSON", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson('quo"te')).toBe(JSON.stringify('quo"te'));
  });
});

describe("fnv1a64", () => {
  it("matches the FNV-1a 64-bit reference vectors", () => {
    expect(fnv1a64("")).toBe("cbf29ce484222325");
    expect(fnv1a64("a")).toBe("af63dc4c8601ec8c");
  });

  it("differs for canonically different requests", () => {
    expect(fnv1a64(canonicalJson({ a: 1 }))).not.toBe(fnv1a64(canonicalJson({ a: 2 })));
  });
});
