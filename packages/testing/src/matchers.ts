import type {
  AgentCapabilityErrorCode,
  AgentInvocationResult,
  AgentSurfaceSnapshot,
  JsonValue,
} from "@agent-surface/core";
import { jsonDeepEqual } from "@agent-surface/core";
import type { TestSurface } from "./harness.js";
import { serializeSurfaceSnapshot } from "./serialize.js";

interface MatcherResult {
  pass: boolean;
  message: () => string;
}

interface CapabilityEntry {
  capabilityId: string;
  available: boolean;
  unavailableReason?: string;
  instanceId?: string;
}

function isTestSurface(value: unknown): value is TestSurface {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as TestSurface).snapshot === "function" &&
    typeof (value as TestSurface).invoke === "function"
  );
}

function collectCapabilities(snapshot: AgentSurfaceSnapshot): CapabilityEntry[] {
  const entries: CapabilityEntry[] = [];
  for (const component of snapshot.components) {
    for (const cap of [...component.observations, ...component.actions]) {
      entries.push({
        capabilityId: cap.capabilityId,
        available: cap.available,
        unavailableReason: cap.unavailableReason,
        instanceId: component.instanceId,
      });
    }
  }
  for (const proc of snapshot.procedures) {
    entries.push({
      capabilityId: proc.procedureId,
      available: proc.available,
      unavailableReason: proc.unavailableReason,
      ...(proc.context ? { instanceId: proc.context.instanceId } : {}),
    });
  }
  return entries;
}

function findEntries(
  surface: TestSurface,
  capabilityId: string,
  opts?: { instanceId?: string },
): CapabilityEntry[] {
  const snapshot = surface.snapshot();
  return collectCapabilities(snapshot).filter(
    (e) =>
      e.capabilityId === capabilityId &&
      (opts?.instanceId === undefined || e.instanceId === opts.instanceId),
  );
}

/**
 * `toExpose` = present AND available for the harness consumer.
 * Hidden ≠ disabled: that distinction is the security model (docs/06).
 */
export function toExpose(
  received: unknown,
  capabilityId: string,
  opts?: { instanceId?: string },
): MatcherResult {
  if (!isTestSurface(received)) {
    return { pass: false, message: () => "toExpose expects a TestSurface" };
  }
  const entries = findEntries(received, capabilityId, opts);
  const pass = entries.some((e) => e.available);
  return {
    pass,
    message: () =>
      pass
        ? `expected surface not to expose ${capabilityId}, but it is exposed and available`
        : entries.length > 0
          ? `expected ${capabilityId} to be available, but it is visible-disabled (${entries[0]?.unavailableReason ?? "no reason"})`
          : `expected surface to expose ${capabilityId}, but it is absent (hidden or unregistered)`,
  };
}

/** `toExposeUnavailable` = present with available: false (+ optional reason). */
export function toExposeUnavailable(
  received: unknown,
  capabilityId: string,
  opts?: { instanceId?: string; reason?: string },
): MatcherResult {
  if (!isTestSurface(received)) {
    return { pass: false, message: () => "toExposeUnavailable expects a TestSurface" };
  }
  const entries = findEntries(received, capabilityId, opts);
  const disabled = entries.filter((e) => !e.available);
  const pass =
    disabled.length > 0 &&
    (opts?.reason === undefined || disabled.some((e) => e.unavailableReason === opts.reason));
  return {
    pass,
    message: () => {
      if (entries.length === 0) {
        return `expected ${capabilityId} to be visible-disabled, but it is absent from the snapshot (hidden)`;
      }
      if (disabled.length === 0) {
        return `expected ${capabilityId} to be visible-disabled, but it is available`;
      }
      return `expected ${capabilityId} unavailableReason ${JSON.stringify(opts?.reason)}, got ${JSON.stringify(disabled[0]?.unavailableReason)}`;
    },
  };
}

export function toBeOk(received: unknown): MatcherResult {
  const result = received as AgentInvocationResult;
  const pass =
    typeof result === "object" && result !== null && (result as { status?: string }).status === "ok";
  return {
    pass,
    message: () =>
      pass
        ? "expected invocation result not to be ok"
        : `expected ok result, got ${JSON.stringify(
            (result as { error?: unknown })?.error ?? result,
          )}`,
  };
}

export function toFailWith(
  received: unknown,
  code: AgentCapabilityErrorCode,
  detailsSubset?: Record<string, JsonValue>,
): MatcherResult {
  const result = received as AgentInvocationResult;
  if (typeof result !== "object" || result === null || result.status !== "error") {
    return {
      pass: false,
      message: () => `expected an error result with code ${code}, got ${JSON.stringify(result)}`,
    };
  }
  if (result.error.code !== code) {
    return {
      pass: false,
      message: () =>
        `expected error code ${code}, got ${result.error.code} (${result.error.message})`,
    };
  }
  if (detailsSubset) {
    for (const [key, expected] of Object.entries(detailsSubset)) {
      const actual = result.error.details?.[key];
      if (!jsonDeepEqual(actual, expected)) {
        return {
          pass: false,
          message: () =>
            `expected details.${key} = ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        };
      }
    }
  }
  return { pass: true, message: () => `expected result not to fail with ${code}` };
}

/**
 * Semantic surface snapshot matcher. Delegates to the runner's own
 * toMatchSnapshot on the normalized form; `serializeSurfaceSnapshot` is the
 * underlying primitive if you prefer explicit snapshots.
 */
export function toMatchSurfaceSnapshot(received: unknown): MatcherResult {
  if (!isTestSurface(received)) {
    return { pass: false, message: () => "toMatchSurfaceSnapshot expects a TestSurface" };
  }
  const normalized = serializeSurfaceSnapshot(received.snapshot());
  const expectFn = (globalThis as { expect?: (v: unknown) => { toMatchSnapshot(): void } }).expect;
  if (!expectFn) {
    return {
      pass: false,
      message: () =>
        "toMatchSurfaceSnapshot requires a global expect with snapshot support (vitest globals or jest)",
    };
  }
  try {
    expectFn(normalized).toMatchSnapshot();
    return { pass: true, message: () => "surface snapshot matched" };
  } catch (err) {
    return {
      pass: false,
      message: () => (err instanceof Error ? err.message : String(err)),
    };
  }
}

export const matchers = {
  toExpose,
  toExposeUnavailable,
  toBeOk,
  toFailWith,
  toMatchSurfaceSnapshot,
};

/**
 * Matcher surface for `expect.extend(matchers)`. Augment your test runner's
 * Assertion interface with this shape, e.g. for vitest:
 *
 *   declare module "vitest" {
 *     interface Assertion<T = any> extends AgentSurfaceMatchers<T> {}
 *   }
 */
export interface AgentSurfaceMatchers<R = unknown> {
  toExpose(capabilityId: string, opts?: { instanceId?: string }): R;
  toExposeUnavailable(
    capabilityId: string,
    opts?: { instanceId?: string; reason?: string },
  ): R;
  toBeOk(): R;
  toFailWith(code: AgentCapabilityErrorCode, detailsSubset?: Record<string, JsonValue>): R;
  toMatchSurfaceSnapshot(): R;
}

// Auto-extend when a global expect (vitest globals / jest) is present.
const globalExpect = (globalThis as { expect?: { extend?: (m: object) => void } }).expect;
if (globalExpect?.extend) {
  globalExpect.extend(matchers);
}
