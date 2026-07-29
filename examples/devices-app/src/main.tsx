import { createRoot } from "react-dom/client";
import { createApp } from "./agent/setup.js";
import { App } from "./app/App.js";

// One registry per page load, created explicitly at app setup (docs/04) and
// kept stable across HMR so reloads don't reset the surface.
const wiring = ((globalThis as Record<string, unknown>).__devicesApp ??= createApp({
  environment: "development",
})) as ReturnType<typeof createApp>;

createRoot(document.getElementById("root")!).render(<App app={wiring} />);
