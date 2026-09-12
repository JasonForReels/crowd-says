/*
  Production server: serves the built site from dist/ and the /api routes.
  Run `npm run build` first. Reads POE_API_KEY (and optional POE_MODEL, TTS,
  TTS_DTYPE, CACHE_DIR) from the environment; PORT is set by the host.
*/
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApi } from "./api.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

// Load .env the way the Vite dev server does, so `npm start` sees the same
// keys as `npm run dev`. Real environment variables still win.
try {
  process.loadEnvFile(path.join(root, ".env"));
} catch {
  /* no .env, or a Node without loadEnvFile — the environment is enough */
}

const api = createApi(process.env, { root });

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
};

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://x");
  let file = path.normalize(path.join(dist, decodeURIComponent(url.pathname)));
  if (!file.startsWith(dist)) {
    res.statusCode = 403;
    return res.end();
  }
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
  } catch {
    file = path.join(dist, "index.html"); // single-page app: unknown paths get the app
  }
  try {
    const body = await readFile(file);
    res.setHeader("Content-Type", TYPES[path.extname(file)] || "application/octet-stream");
    // Hashed build assets never change; the HTML must always be fresh.
    res.setHeader("Cache-Control", file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
}

createServer((req, res) => {
  api(req, res, () => serveStatic(req, res));
}).listen(Number(process.env.PORT) || 3000, () => {
  console.log(`[crowd-says] listening on :${process.env.PORT || 3000}`);
  if (!process.env.POE_API_KEY) console.warn("[crowd-says] POE_API_KEY missing — boards will use the built-in bank");
});
