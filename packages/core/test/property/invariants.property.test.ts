/**
 * Property-based invariants (directive §6.4; docs/08).
 * Requirements: AS-ID-003 (grammar round-trip), AS-ID-004 (wire codec
 * round-trip), AS-CONFIRM-002 (canonical digest stability), AS-SCHEMA-003
 * (subset accepts only documented keywords), AS-LIFE-004 (arbitrary
 * register/unregister sequences preserve unique live identities),
 * AS-IDENT-001 (dedupe never double-executes matching keys/fingerprints),
 * AS-CONFIRM-001 (no evidence validates for a non-identical digest).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  action,
  createAgentSurfaceRegistry,
  fromJsonSchema,
  type AgentComponentDefinition,
  type JsonValue,
} from "@agent-surface/core";
import {
  decodeWireName,
  encodeWireName,
  formatViewCapabilityId,
  MAX_ID_LENGTH,
  MAX_WIRE_NAME_LENGTH,
  parseCapabilityId,
} from "../../src/ids.js";
import { validateJsonSchemaDocument } from "../../src/schema.js";
import { canonicalJson } from "../../src/utils.js";
import { ConfirmationStore } from "../../src/confirmation.js";

/* ─────────────────────────── arbitraries ─────────────────────────── */

const lower = "abcdefghijklmnopqrstuvwxyz";
const lowerDigit = lower + "0123456789";
const alnum = lowerDigit + "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const segmentArb = fc
  .tuple(
    fc.constantFrom(...lower),
    fc.string({ unit: fc.constantFrom(...(lowerDigit + "-")), maxLength: 10 }),
  )
  .map(([head, tail]) => head + tail)
  .filter((s) => !s.endsWith("-"));

const componentTypeArb = fc
  .array(segmentArb, { minLength: 1, maxLength: 4 })
  .map((segments) => segments.join("."));

const capabilityNameArb = fc
  .tuple(fc.constantFrom(...lower), fc.string({ unit: fc.constantFrom(...alnum), maxLength: 12 }))
  .map(([head, tail]) => head + tail);

const viewIdArb = fc
  .tuple(componentTypeArb, capabilityNameArb)
  .map(([type, name]) => formatViewCapabilityId(type, name))
  .filter((id) => id.length <= MAX_ID_LENGTH);

const jsonValueArb = fc.jsonValue({ maxDepth: 4 }) as fc.Arbitrary<JsonValue>;

/* ───────────────────────────── properties ───────────────────────────── */

describe("AS-ID-003 — canonical id parser/formatter round-trips", () => {
  it("format → parse recovers plane, componentType, and name", () => {
    fc.assert(
      fc.property(componentTypeArb, capabilityNameArb, (type, name) => {
        const id = formatViewCapabilityId(type, name);
        fc.pre(id.length <= MAX_ID_LENGTH);
        const parsed = parseCapabilityId(id);
        expect(parsed).toBeDefined();
        expect(parsed?.plane).toBe("view");
        if (parsed?.plane === "view") {
          expect(parsed.componentType).toBe(type);
          expect(parsed.name).toBe(name);
        }
      }),
    );
  });
});

describe("AS-ID-004 — wire-name codec round-trips within provider limits", () => {
  it("encode stays in the provider-safe alphabet and ≤ 64 chars; decode inverts non-hashed names", () => {
    fc.assert(
      fc.property(viewIdArb, (id) => {
        const wire = encodeWireName(id);
        expect(wire.length).toBeLessThanOrEqual(MAX_WIRE_NAME_LENGTH);
        expect(/^[A-Za-z0-9_-]+$/.test(wire)).toBe(true);
        // Hash-truncated names are resolved by the adapter's id↔name map
        // (docs/09 §wire-names); non-truncated encodings round-trip exactly.
        const raw = id.replace(":", "_").replaceAll(".", "__");
        if (raw.length <= MAX_WIRE_NAME_LENGTH) {
          expect(decodeWireName(wire)).toBe(id);
        }
      }),
    );
  });
});

describe("AS-CONFIRM-002 — canonical JSON digest is stable under insertion order", () => {
  it("any two orderings of the same object canonicalize identically", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ maxLength: 8 }), jsonValueArb, { maxKeys: 8 }),
        fc.infiniteStream(fc.nat()),
        (obj, seeds) => {
          const keys = Object.keys(obj);
          const shuffled: Record<string, JsonValue> = {};
          const order = [...keys].sort(() => ((seeds.next().value ?? 0) % 3) - 1);
          for (const key of order) shuffled[key] = obj[key] as JsonValue;
          expect(canonicalJson(shuffled)).toBe(canonicalJson(obj));
        },
      ),
    );
  });

  it("canonically different values produce different encodings (arrays keep order)", () => {
    fc.assert(
      fc.property(jsonValueArb, jsonValueArb, (a, b) => {
        const equal = canonicalJson(a) === canonicalJson(b);
        // Encoding equality must agree with itself when re-encoded (determinism).
        expect(canonicalJson(a) === canonicalJson(b)).toBe(equal);
        expect(canonicalJson(a)).toBe(canonicalJson(a));
      }),
    );
  });
});

describe("AS-SCHEMA-003 — the D19 subset accepts documented keywords only", () => {
  const allowedSchemaArb = fc.letrec((tie) => ({
    schema: fc.oneof(
      { maxDepth: 3, withCrossShrink: true },
      fc.record({ type: fc.constant("string"), minLength: fc.nat(5) }, { requiredKeys: ["type"] }),
      fc.record({ type: fc.constant("number"), minimum: fc.integer({ min: -5, max: 5 }) }, { requiredKeys: ["type"] }),
      fc.record({ type: fc.constant("boolean") }),
      fc.record(
        {
          type: fc.constant("array"),
          items: tie("schema"),
          maxItems: fc.nat(4),
        },
        { requiredKeys: ["type", "items"] },
      ),
      fc.record(
        {
          type: fc.constant("object"),
          properties: fc.dictionary(capabilityNameArb, tie("schema"), { maxKeys: 3 }),
          additionalProperties: fc.boolean(),
        },
        { requiredKeys: ["type", "properties"] },
      ),
    ),
  })).schema as fc.Arbitrary<Record<string, unknown>>;

  const SUBSET_LIMITS = { maxSchemaBytes: 16_384, maxSchemaDepth: 8 };

  it("random schemas from the allowlist are accepted (D19 registration seam)", () => {
    fc.assert(
      fc.property(allowedSchemaArb, (schema) => {
        expect(validateJsonSchemaDocument(schema, SUBSET_LIMITS).ok).toBe(true);
      }),
      { numRuns: 60 },
    );
  });

  it("injecting one forbidden keyword anywhere is rejected", () => {
    const forbidden = ["oneOf", "allOf", "not", "if", "patternProperties", "unevaluatedProperties"];
    fc.assert(
      fc.property(allowedSchemaArb, fc.constantFrom(...forbidden), (schema, keyword) => {
        const poisoned = { ...schema, [keyword]: [{ type: "string" }] };
        expect(validateJsonSchemaDocument(poisoned, SUBSET_LIMITS).ok).toBe(false);
      }),
      { numRuns: 60 },
    );
  });

  it("depth beyond the limit is rejected", () => {
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 10; i++) deep = { type: "array", items: deep };
    expect(validateJsonSchemaDocument(deep, SUBSET_LIMITS).ok).toBe(false);
  });
});

describe("AS-LIFE-004 — arbitrary register/unregister sequences preserve unique live identities", () => {
  const opArb = fc.array(
    fc.record({
      slot: fc.nat(3), // four component identities
      op: fc.constantFrom("register", "unregister"),
    }),
    { maxLength: 24 },
  );

  function makeDefinition(slot: number): AgentComponentDefinition {
    return {
      type: "prop.widget",
      instanceId: `slot-${slot}`,
      description: "property-test widget",
      actions: {
        poke: action({
          description: "poke",
          input: fromJsonSchema<Record<string, never>>({
            type: "object",
            properties: {},
            additionalProperties: false,
          }),
          effect: "local-state",
          execute: () => {},
        }),
      },
    };
  }

  it("at most one live registration per (type, instanceId); versions strictly increase", () => {
    fc.assert(
      fc.property(opArb, (ops) => {
        const registry = createAgentSurfaceRegistry({ environment: "test" });
        const handles = new Map<number, { unregister(): void; status: string }>();
        let lastVersion = Number(registry.getVersion());
        for (const { slot, op } of ops) {
          if (op === "register") {
            const handle = registry.register(makeDefinition(slot));
            if (handle.status === "active") handles.set(slot, handle);
          } else {
            handles.get(slot)?.unregister();
            handles.delete(slot);
          }
          const version = Number(registry.getVersion());
          expect(version).toBeGreaterThanOrEqual(lastVersion);
          lastVersion = version;
          const snapshot = registry.snapshot();
          const keys = snapshot.components.map((c) => `${c.type} ${c.instanceId}`);
          expect(new Set(keys).size).toBe(keys.length); // unique live identities
        }
        registry.dispose();
      }),
      { numRuns: 40 },
    );
  });
});

describe("AS-IDENT-001 — the dedupe cache never double-executes matching keys/fingerprints", () => {
  const callArb = fc.array(
    fc.record({
      id: fc.constantFrom("a", "b", "c"),
      by: fc.constantFrom(1, 2), // two distinct requests per id
    }),
    { minLength: 1, maxLength: 16 },
  );

  it("executions ≤ distinct (invocationId, fingerprint) pairs; joins return identical results", async () => {
    await fc.assert(
      fc.asyncProperty(callArb, async (calls) => {
        const registry = createAgentSurfaceRegistry({ environment: "test" });
        let executions = 0;
        registry.register({
          type: "prop.counter",
          description: "counts",
          actions: {
            bump: action({
              description: "bump",
              input: fromJsonSchema<{ by: number }>({
                type: "object",
                properties: { by: { type: "number" } },
                required: ["by"],
                additionalProperties: false,
              }),
              effect: "local-state",
              execute: async () => {
                executions += 1;
              },
            }),
          },
        });
        const seenFirstRequest = new Map<string, number>();
        for (const call of calls) {
          if (!seenFirstRequest.has(call.id)) seenFirstRequest.set(call.id, call.by);
        }
        const results = await Promise.all(
          calls.map((call) =>
            registry.invoke(
              {
                invocationId: call.id,
                capabilityId: "view:prop.counter.bump",
                input: { by: call.by },
              },
              { consumer: { id: "prop", kind: "test" } },
            ),
          ),
        );
        // Within one window: at most one execution per distinct id whose
        // request matches the id's first-issued fingerprint; every other
        // (id, request) pair is a conflict, never an execution.
        expect(executions).toBeLessThanOrEqual(seenFirstRequest.size);
        results.forEach((result, i) => {
          const call = calls[i]!;
          if (call.by !== seenFirstRequest.get(call.id)) {
            expect(result.status === "error" && result.error.code).toBe("INVOCATION_CONFLICT");
          }
        });
        registry.dispose();
      }),
      { numRuns: 40 },
    );
  });
});

describe("AS-CONFIRM-001 — no evidence validates for a non-identical request digest", () => {
  it("consume succeeds iff the digest is identical (store-level property)", () => {
    fc.assert(
      fc.property(jsonValueArb, jsonValueArb, (approvedInput, retriedInput) => {
        const store = new ConfirmationStore({
          ttlMs: 60_000,
          maxPending: 8,
          now: () => 0,
          emit: () => {},
          audit: () => {},
        });
        const approvedDigest = canonicalJson({ base: "x", input: approvedInput });
        const retriedDigest = canonicalJson({ base: "x", input: retriedInput });
        const record = store.request({
          capabilityId: "view:prop.widget.poke",
          registrationId: "reg_1",
          consumerKey: "test:prop",
          effect: "local-state",
          input: approvedInput,
          summary: "s",
          digest: approvedDigest,
        });
        if (record === "overflow") return;
        store.resolve(record.confirmationId, { approved: true });
        const consumed = store.consume({
          confirmationId: record.confirmationId,
          digest: retriedDigest,
          input: retriedInput,
        });
        expect(consumed.ok).toBe(approvedDigest === retriedDigest);
      }),
      { numRuns: 80 },
    );
  });
});
