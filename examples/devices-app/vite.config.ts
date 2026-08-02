import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { agentSurface } from "@agent-surface/compiler";

export default defineConfig({
  plugins: [agentSurface(), react()],
});
