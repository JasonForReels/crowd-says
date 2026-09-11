import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { createApi } from "./server/api.js";

// Serves /api/* from the Vite dev and preview servers, so the Poe key stays
// on the server. Production uses the same handler via server/index.js.
function surveyApi(env) {
  const handler = createApi(env);
  return {
    name: "survey-api",
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ""); // "" = load non-VITE_ vars, server-side only
  return { plugins: [react(), surveyApi(env)] };
});
