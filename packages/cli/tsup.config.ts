import { defineConfig } from "tsup";

export default defineConfig({
  // `collect` is a separate entry on purpose: it is the only module executed
  // *inside* the vite-node graph (see src/collect.ts), so it must stay a file
  // the runner can be pointed at, never inlined into the CLI bundle.
  entry: ["src/index.ts", "src/bin.ts", "src/vitest.ts", "src/collect.ts"],
  format: ["esm"],
  dts: { entry: ["src/index.ts", "src/vitest.ts"] },
  sourcemap: true,
  clean: true,
  target: "es2022",
  external: [
    "react",
    "react-dom",
    "ink",
    "jsdom",
    "vite-node",
    "@testing-library/react",
    "@agent-surface/core",
    "@agent-surface/core/explain",
    "@agent-surface/react",
    "@agent-surface/testing",
    "@agent-surface/testing/react",
  ],
});
