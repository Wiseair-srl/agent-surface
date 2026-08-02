import { createHash } from "node:crypto";
import type { CapabilityContractManifest } from "@agent-surface/core";

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, normalize(entry)]),
  );
}

export function canonicalJson(value: unknown, pretty = false): string {
  return `${JSON.stringify(normalize(value), null, pretty ? 2 : undefined)}\n`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function manifestPayload(
  manifest: Omit<CapabilityContractManifest, "hash"> | CapabilityContractManifest,
): Omit<CapabilityContractManifest, "hash"> {
  const { hash: _hash, ...payload } = manifest as CapabilityContractManifest;
  return payload;
}

export function computeManifestHash(
  manifest: Omit<CapabilityContractManifest, "hash"> | CapabilityContractManifest,
): string {
  return sha256(canonicalJson(manifestPayload(manifest)));
}

export function canonicalManifestJson(manifest: CapabilityContractManifest): string {
  return canonicalJson(manifest, true);
}

export function verifyManifest(manifest: CapabilityContractManifest): void {
  if (computeManifestHash(manifest) !== manifest.hash) {
    throw new Error(`capability contract hash mismatch: ${manifest.hash}`);
  }
}
