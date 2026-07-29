// Conformance: AS-SCHEMA-001 (D19 subset validator), AS-SCHEMA-002 (Standard Schema, D20)
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentSchemaError,
  DEFAULT_LIMITS,
  emptyObjectSchema,
  fromJsonSchema,
  fromStandardSchema,
  validateJsonSchemaDocument,
  type StandardSchemaV1,
} from "@agent-surface/core";

const limits = { maxSchemaBytes: DEFAULT_LIMITS.maxSchemaBytes, maxSchemaDepth: DEFAULT_LIMITS.maxSchemaDepth };

describe("D19 subset document validator", () => {
  it("accepts the supported keyword set", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true },
        mode: { type: "string", enum: ["replace", "add", "remove"], default: "replace" },
        count: { type: "integer", minimum: 0, maximum: 10, multipleOf: 1 },
        when: { type: "string", format: "date-time", description: "ISO timestamp" },
        nested: { $ref: "#/$defs/nested" },
        union: { anyOf: [{ type: "string" }, { type: "null" }] },
        nullable: { type: ["string", "null"] },
      },
      required: ["ids"],
      additionalProperties: false,
      $defs: { nested: { type: "object", properties: { a: { type: "boolean" } } } },
    };
    expect(validateJsonSchemaDocument(schema, limits)).toEqual({ ok: true });
  });

  it.each([
    ["oneOf", { oneOf: [{ type: "string" }] }],
    ["allOf", { allOf: [{ type: "string" }] }],
    ["not", { not: { type: "string" } }],
    ["if/then", { if: { type: "string" }, then: { type: "string" } }],
    ["patternProperties", { type: "object", patternProperties: { "^x": { type: "string" } } }],
    ["unknown keyword", { type: "string", contentEncoding: "base64" }],
    ["remote ref", { $ref: "https://example.com/schema.json" }],
    ["non-defs local ref", { $ref: "#/properties/x" }],
    ["object additionalProperties", { type: "object", additionalProperties: { type: "string" } }],
    ["tuple items", { type: "array", items: [{ type: "string" }] }],
    ["bad type", { type: "function" }],
    ["bad format", { type: "string", format: "hostname" }],
  ])("rejects %s", (_label, schema) => {
    expect(validateJsonSchemaDocument(schema as Record<string, unknown>, limits).ok).toBe(false);
  });

  it("rejects schemas beyond the depth cap", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 10; i++) {
      schema = { type: "object", properties: { deep: schema } };
    }
    expect(validateJsonSchemaDocument(schema, limits).ok).toBe(false);
  });

  it("rejects oversized schemas", () => {
    const schema = {
      type: "object",
      properties: { big: { type: "string", description: "x".repeat(20_000) } },
    };
    expect(validateJsonSchemaDocument(schema, limits).ok).toBe(false);
  });
});

describe("fromJsonSchema built-in validator", () => {
  const schema = fromJsonSchema<{ ids: string[]; mode?: string }>({
    type: "object",
    properties: {
      ids: { type: "array", items: { type: "string" }, minItems: 1 },
      mode: { type: "string", enum: ["replace", "add", "remove"] },
    },
    required: ["ids"],
    additionalProperties: false,
  });

  it("accepts valid values", () => {
    expect(schema.parse({ ids: ["d1"], mode: "add" })).toEqual({ ids: ["d1"], mode: "add" });
  });

  it("throws AgentSchemaError with structured issues", () => {
    try {
      schema.parse({ ids: [], mode: "nope", extra: 1 });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AgentSchemaError);
      const issues = (err as AgentSchemaError).issues;
      expect(issues.some((i) => i.path === "ids")).toBe(true);
      expect(issues.some((i) => i.path === "mode")).toBe(true);
      expect(issues.some((i) => i.path === "extra")).toBe(true);
    }
  });

  it("reports missing required fields", () => {
    expect(() => schema.parse({})).toThrow(AgentSchemaError);
  });

  it("validates numbers, formats, refs and anyOf", () => {
    const s = fromJsonSchema({
      type: "object",
      properties: {
        n: { type: "integer", exclusiveMinimum: 0 },
        when: { type: "string", format: "date" },
        u: { anyOf: [{ type: "string" }, { type: "number" }] },
        r: { $ref: "#/$defs/point" },
      },
      $defs: { point: { type: "object", properties: { x: { type: "number" } }, required: ["x"] } },
    });
    expect(() => s.parse({ n: 0 })).toThrow(AgentSchemaError);
    expect(() => s.parse({ when: "not-a-date" })).toThrow(AgentSchemaError);
    expect(() => s.parse({ u: true })).toThrow(AgentSchemaError);
    expect(() => s.parse({ r: {} })).toThrow(AgentSchemaError);
    expect(s.parse({ n: 2, when: "2026-07-29", u: "ok", r: { x: 1 } })).toBeTruthy();
  });

  it("emptyObjectSchema accepts {} and rejects extras", () => {
    expect(emptyObjectSchema.parse({})).toEqual({});
    expect(() => emptyObjectSchema.parse({ a: 1 })).toThrow(AgentSchemaError);
  });
});

describe("fromStandardSchema (D20)", () => {
  it("Zod 4 toJSONSchema output stays inside the D19 subset (registration-safe)", () => {
    const SelectRows = z.object({
      ids: z.array(z.string()).min(1),
      mode: z.enum(["replace", "add", "remove"]).default("replace"),
    });
    const Filters = z
      .object({
        status: z.enum(["all", "online", "offline"]),
        city: z.string().nullable().describe("Exact city name filter, null = all cities"),
      })
      .partial();
    expect(validateJsonSchemaDocument(z.toJSONSchema(SelectRows), limits)).toEqual({ ok: true });
    expect(validateJsonSchemaDocument(z.toJSONSchema(Filters), limits)).toEqual({ ok: true });
  });

  it("wraps Zod 4 via Standard Schema, applying zod defaults", () => {
    const SelectRows = z.object({
      ids: z.array(z.string()).min(1),
      mode: z.enum(["replace", "add", "remove"]).default("replace"),
    });
    const schema = fromStandardSchema(SelectRows, { jsonSchema: z.toJSONSchema(SelectRows) });
    expect(schema.parse({ ids: ["d1"] })).toEqual({ ids: ["d1"], mode: "replace" });
    expect(() => schema.parse({ ids: [] })).toThrow(AgentSchemaError);
    try {
      schema.parse({ ids: 42 });
      expect.unreachable();
    } catch (err) {
      expect((err as AgentSchemaError).issues[0]?.path).toBe("ids");
    }
  });

  it("wraps any hand-rolled Standard Schema implementation", () => {
    const upper: StandardSchemaV1<unknown, string> = {
      "~standard": {
        version: 1,
        vendor: "hand-rolled",
        validate(value) {
          return typeof value === "string"
            ? { value: value.toUpperCase() }
            : { issues: [{ message: "expected string" }] };
        },
      },
    };
    const schema = fromStandardSchema(upper, { jsonSchema: { type: "string" } });
    expect(schema.parse("abc")).toBe("ABC");
    expect(() => schema.parse(1)).toThrow(AgentSchemaError);
  });

  it("rejects async validation in v0.1", () => {
    const asyncSchema: StandardSchemaV1<unknown, string> = {
      "~standard": {
        version: 1,
        vendor: "async",
        validate() {
          return Promise.resolve({ value: "x" });
        },
      },
    };
    const schema = fromStandardSchema(asyncSchema, { jsonSchema: { type: "string" } });
    expect(() => schema.parse("x")).toThrow(AgentSchemaError);
  });
});
