export { createTestSurface } from "./harness.js";
export type { TestSurface, TestSurfaceOptions } from "./harness.js";
export { serializeSurfaceSnapshot } from "./serialize.js";
export type { SerializeSurfaceOptions } from "./serialize.js";
export {
  matchers,
  toExpose,
  toExposeUnavailable,
  toBeOk,
  toFailWith,
  toMatchSurfaceSnapshot,
} from "./matchers.js";
export type { AgentSurfaceMatchers } from "./matchers.js";
