import { resolve } from "node:path";
import type { CapabilityContractManifest } from "@agent-surface/core";
import { build, type InlineConfig } from "vite";
import { agentSurface } from "./plugin.js";

export interface CompileCapabilityContractOptions {
  root?: string;
  configFile?: string;
  target?: string;
  vite?: InlineConfig;
}

export async function compileCapabilityContract(
  options: CompileCapabilityContractOptions = {},
): Promise<CapabilityContractManifest> {
  let manifest: CapabilityContractManifest | undefined;
  const root = resolve(options.root ?? process.cwd());
  const result = await build({
    ...(options.vite ?? {}),
    root,
    ...(options.configFile ? { configFile: resolve(root, options.configFile) } : {}),
    logLevel: options.vite?.logLevel ?? "silent",
    build: {
      ...(options.vite?.build ?? {}),
      write: false,
    },
    plugins: [
      ...(options.vite?.plugins ?? []),
      agentSurface({
        target: options.target,
        emit: false,
        onManifest: (value) => {
          manifest = value;
        },
      }),
    ],
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs) {
    if (!("output" in output)) continue;
    const asset = output.output.find(
      (entry) => entry.type === "asset" && entry.fileName === "agent-surface.contract.json",
    );
    if (asset?.type === "asset") {
      const source = typeof asset.source === "string"
        ? asset.source
        : new TextDecoder().decode(asset.source);
      manifest = JSON.parse(source) as CapabilityContractManifest;
      break;
    }
  }
  if (!manifest) throw new Error("compiler did not produce a capability contract");
  return manifest;
}
