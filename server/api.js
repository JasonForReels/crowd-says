/*
  The /api/* routes, shared by the Vite dev server (vite.config.js) and the
  production server (server/index.js). Connect-style: handler(req, res, next).
*/
import path from "node:path";
import { createSurveyService } from "./poe.js";
import { createTts } from "./tts.js";

// Per-IP fixed-window limits: a public site shouldn't let one visitor burn
// the Poe balance or pin the CPU with speech synthesis.
const LIMITS = { survey: 40, judge: 120, tts: 600, daily: 60 };
const WINDOW_MS = 10 * 60 * 1000;

function limiter() {
  const hits = new Map();
  setInterval(() => hits.clear(), WINDOW_MS).unref();
  return (req, bucket) => {
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
    const k = `${bucket}|${ip}`;
    const n = (hits.get(k) || 0) + 1;
    hits.set(k, n);
    return n <= LIMITS[bucket];
  };
}

export function createApi(env, { root = process.cwd() } = {}) {
  const cacheDir = path.resolve(root, env.CACHE_DIR || ".cache");
  const svc = createSurveyService({
    key: env.POE_API_KEY,
    model: env.POE_MODEL || "GPT-5-nano",
    cacheDir,
    dailiesFile: path.resolve(root, "server/dailies.json"),
  });
  const ttsEnabled = (env.TTS || "kokoro") !== "off";
  const tts = ttsEnabled ? createTts({ cacheDir }) : null;
  const allow = limiter();

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let s = "";
      req.on("data", (c) => {
        s += c;
        if (s.length > 20000) {
          reject(new Error("Body too large"));
          req.destroy();
        }
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(s || "{}"));
        } catch (e) {
          reject(e);
        }
      });
    });

  const send = (res, code, obj) => {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  };
  const limited = (res) => send(res, 429, { error: "slow down" });

  return async function handler(req, res, next) {
    const url = new URL(req.url, "http://x");
    if (!url.pathname.startsWith("/api/")) return next();
    try {
      if (url.pathname === "/api/daily" && req.method === "GET") {
        if (!allow(req, "daily")) return limited(res);
        const day = Number(url.searchParams.get("day"));
        if (!Number.isInteger(day) || day < 1 || day > 100000) return send(res, 400, { error: "bad day" });
        return send(res, 200, await svc.daily(day));
      }
      if (url.pathname === "/api/survey" && req.method === "POST") {
        if (!allow(req, "survey")) return limited(res);
        const { avoid = [], quick = false } = await readBody(req);
        return send(res, 200, await svc.generate(Array.isArray(avoid) ? avoid.map(String).slice(-15) : [], Boolean(quick)));
      }
      if (url.pathname === "/api/judge" && req.method === "POST") {
        if (!allow(req, "judge")) return limited(res);
        const { q, answers, guess } = await readBody(req);
        if (typeof q !== "string" || !Array.isArray(answers) || typeof guess !== "string")
          return send(res, 400, { error: "bad request" });
        const index = await svc.judge({
          q: q.slice(0, 200),
          answers: answers.slice(0, 8).map((a) => String(a).slice(0, 40)),
          guess: guess.slice(0, 60),
        });
        return send(res, 200, { index });
      }
      if (url.pathname === "/api/tts/status") {
        if (!tts) return send(res, 200, { ready: false, loading: false, failed: "disabled on this server" });
        tts.load(); // asking is enough to start the model loading
        return send(res, 200, tts.status());
      }
      if (url.pathname === "/api/tts/warm" && req.method === "POST") {
        if (!tts) return send(res, 202, { ok: false });
        const { items = [] } = await readBody(req);
        tts.warm(
          (Array.isArray(items) ? items : [])
            .slice(0, 60)
            .map((x) => ({ text: String(x?.text ?? "").slice(0, 160), voice: String(x?.voice ?? "") }))
            .filter((x) => x.text && x.voice)
        );
        return send(res, 202, { ok: true });
      }
      if (url.pathname === "/api/tts" && req.method === "GET") {
        if (!tts) return send(res, 404, { error: "tts disabled" });
        if (!allow(req, "tts")) return limited(res);
        const text = (url.searchParams.get("text") || "").slice(0, 160);
        const voice = url.searchParams.get("voice") || "";
        if (!text || !voice) return send(res, 400, { error: "text and voice required" });
        const wav = await tts.wav(text, voice);
        res.setHeader("Content-Type", "audio/wav");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.end(wav);
      }
      if (url.pathname === "/api/health") return send(res, 200, { ok: true });
    } catch (e) {
      console.error("[crowd-says]", e.message);
      return send(res, 502, { error: "generation failed" });
    }
    return send(res, 404, { error: "not found" });
  };
}
