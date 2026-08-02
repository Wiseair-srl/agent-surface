/// <reference types="vite/client" />

declare module "virtual:agent-surface-contract" {
  import type { CapabilityAuthority, CapabilityContractManifest } from "@agent-surface/core";
  const authority: CapabilityAuthority;
  export const manifest: CapabilityContractManifest;
  export default authority;
}
