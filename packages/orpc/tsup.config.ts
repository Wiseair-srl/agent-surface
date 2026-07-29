import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/react.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  external: ["react", "@agent-surface/core", "@agent-surface/react"],
});
