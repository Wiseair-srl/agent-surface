export {
  canonicalJson,
  canonicalManifestJson,
  computeManifestHash,
  manifestPayload,
  sha256,
  verifyManifest,
} from "./canonical.js";
export {
  agentSurface,
  COMPILER_VERSION,
  CONTRACT_FILE,
  VIRTUAL_CONTRACT_ID,
} from "./plugin.js";
export type {
  AgentSurfaceCompilerOptions,
  PinnedContractInput,
} from "./plugin.js";
export { compileCapabilityContract } from "./compile.js";
export type { CompileCapabilityContractOptions } from "./compile.js";
