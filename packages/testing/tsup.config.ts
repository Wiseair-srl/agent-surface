import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/react.ts", "src/matchers.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  external: ["react", "react-dom", "@testing-library/react", "@agent-surface/react", "@agent-surface/core"],
});
