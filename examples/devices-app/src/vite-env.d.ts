/// <reference types="vite/client" />

declare module "virtual:agent-surface-contract" {
  import type { CapabilityContractManifest } from "@agent-surface/core";
  const manifest: CapabilityContractManifest;
  export default manifest;
}
