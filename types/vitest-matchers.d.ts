import type { AgentSurfaceMatchers } from "@agent-surface/testing";

declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Assertion<T = any> extends AgentSurfaceMatchers<T> {}
  interface AsymmetricMatchersContaining extends AgentSurfaceMatchers {}
}
