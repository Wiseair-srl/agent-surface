// Conformance: AS-SCHEMA-001 (registration-time rejection), AS-LIFE-002 (structural defects thrown)
import { describe, expect, it } from "vitest";
import {
  AgentSurfaceDefinitionError,
  action,
  createAgentSurfaceRegistry,
  defineAgentComponent,
  fromJsonSchema,
  observation,
} from "@agent-surface/core";
import { disableBinding, makeDevicesState } from "./helpers.js";

const anyObject = fromJsonSchema({ type: "object", additionalProperties: true });

function expectDefinitionError(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable("expected AgentSurfaceDefinitionError");
  } catch (err) {
    expect(err).toBeInstanceOf(AgentSurfaceDefinitionError);
    expect((err as AgentSurfaceDefinitionError).code).toBe(code);
  }
}

describe("registration-time structural errors (docs/07) — thrown in every environment", () => {
  const registry = createAgentSurfaceRegistry({ environment: "production" });

  it("INVALID_ID: bad component type", () => {
    expectDefinitionError(
      () => registry.register(defineAgentComponent({ type: "Devices.Table", description: "x" })),
      "INVALID_ID",
    );
  });

  it("INVALID_ID: bad instanceId", () => {
    expectDefinitionError(
      () =>
        registry.register(
          defineAgentComponent({ type: "devices.table", instanceId: "a.b", description: "x" }),
        ),
      "INVALID_ID",
    );
  });

  it("INVALID_ID: bad capability name", () => {
    expectDefinitionError(
      () =>
        registry.register(
          defineAgentComponent({
            type: "devices.table",
            description: "x",
            actions: {
              Select_Rows: action({
                description: "x",
                input: anyObject,
                effect: "local-state",
                execute: () => {},
              }),
            },
          }),
        ),
      "INVALID_ID",
    );
  });

  it("INVALID_DEFINITION: empty description", () => {
    expectDefinitionError(
      () => registry.register(defineAgentComponent({ type: "devices.table", description: "  " })),
      "INVALID_DEFINITION",
    );
  });

  it("INVALID_DEFINITION: unknown fields", () => {
    expectDefinitionError(
      () =>
        registry.register({
          type: "devices.table",
          description: "x",
          bogus: true,
        } as never),
      "INVALID_DEFINITION",
    );
  });

  it("INVALID_DEFINITION: non-JsonValue meta", () => {
    expectDefinitionError(
      () =>
        registry.register(
          defineAgentComponent({
            type: "devices.table",
            description: "x",
            meta: { fn: (() => {}) as never },
          }),
        ),
      "INVALID_DEFINITION",
    );
  });

  it("UNSUPPORTED_SCHEMA: schema outside the D19 subset", () => {
    expectDefinitionError(
      () =>
        registry.register(
          defineAgentComponent({
            type: "devices.table",
            description: "x",
            actions: {
              act: action({
                description: "x",
                input: fromJsonSchema({ oneOf: [{ type: "string" }] }),
                effect: "local-state",
                execute: () => {},
              }),
            },
          }),
        ),
      "UNSUPPORTED_SCHEMA",
    );
  });

  it("PLANE_VIOLATION: view action declaring a server effect", () => {
    expectDefinitionError(
      () =>
        registry.register(
          defineAgentComponent({
            type: "devices.table",
            description: "x",
            actions: {
              disable: action({
                description: "x",
                input: anyObject,
                effect: "server-mutation" as never,
                execute: () => {},
              }),
            },
          }),
        ),
      "PLANE_VIOLATION",
    );
  });

  it("PLANE_VIOLATION: procedure binding without an installed executor", () => {
    expectDefinitionError(
      () =>
        registry.register(
          defineAgentComponent({
            type: "devices.table",
            description: "x",
            procedures: [disableBinding(makeDevicesState())],
          }),
        ),
      "PLANE_VIOLATION",
    );
  });

  it("DUPLICATE_CAPABILITY: same name across observations and actions", () => {
    expectDefinitionError(
      () =>
        registry.register(
          defineAgentComponent({
            type: "devices.table",
            description: "x",
            observations: {
              state: observation({ description: "x", output: anyObject, read: () => ({}) }),
            },
            actions: {
              state: action({
                description: "x",
                input: anyObject,
                effect: "local-state",
                execute: () => {},
              }),
            },
          }),
        ),
      "DUPLICATE_CAPABILITY",
    );
  });

  it("LIMIT_EXCEEDED: component description over 500 chars", () => {
    expectDefinitionError(
      () =>
        registry.register(
          defineAgentComponent({ type: "devices.table", description: "x".repeat(501) }),
        ),
      "LIMIT_EXCEEDED",
    );
  });

  it("LIMIT_EXCEEDED: capability description over 300 chars", () => {
    expectDefinitionError(
      () =>
        registry.register(
          defineAgentComponent({
            type: "devices.table",
            description: "x",
            observations: {
              read: observation({
                description: "x".repeat(301),
                output: anyObject,
                read: () => ({}),
              }),
            },
          }),
        ),
      "LIMIT_EXCEEDED",
    );
  });

  it("LIMIT_EXCEEDED: meta over 2 kB", () => {
    expectDefinitionError(
      () =>
        registry.register(
          defineAgentComponent({
            type: "devices.table",
            description: "x",
            meta: { blob: "x".repeat(3000) },
          }),
        ),
      "LIMIT_EXCEEDED",
    );
  });
});
