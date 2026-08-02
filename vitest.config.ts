import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

const alias = {
  "@agent-surface/core/explain": r("./packages/core/src/explain.ts"),
  "@agent-surface/core": r("./packages/core/src/index.ts"),
  "@agent-surface/compiler": r("./packages/compiler/src/index.ts"),
  "@agent-surface/cli": r("./packages/cli/src/index.ts"),
  "@agent-surface/react": r("./packages/react/src/index.ts"),
  "@agent-surface/orpc/react": r("./packages/orpc/src/react.ts"),
  "@agent-surface/orpc": r("./packages/orpc/src/index.ts"),
  "@agent-surface/testing/react": r("./packages/testing/src/react.ts"),
  "@agent-surface/testing/matchers": r("./packages/testing/src/matchers.ts"),
  "@agent-surface/testing": r("./packages/testing/src/index.ts"),
  "@agent-surface/webmcp": r("./packages/webmcp/src/index.ts"),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "node",
          environment: "node",
          globals: true,
          setupFiles: ["./vitest.setup.authority.ts"],
          include: [
            "packages/core/test/**/*.test.ts",
            "packages/compiler/test/**/*.test.ts",
            "packages/cli/test/**/*.test.ts",
            "packages/testing/test/**/*.test.ts",
            "packages/orpc/test/**/*.test.ts",
            "packages/webmcp/test/**/*.test.ts",
          ],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "dom",
          environment: "jsdom",
          globals: true,
          setupFiles: ["./vitest.setup.authority.ts", "./vitest.setup.dom.ts"],
          include: [
            "packages/react/test/**/*.test.tsx",
            "packages/react/test/**/*.test.ts",
            "packages/testing/test-react/**/*.test.tsx",
            "packages/orpc/test-react/**/*.test.tsx",
            "examples/devices-app/test/**/*.test.tsx",
          ],
        },
      },
    ],
  },
});
