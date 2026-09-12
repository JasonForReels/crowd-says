/*
  Text-to-speech via Gemini's TTS models. Clips are cached to disk, so a line
  is only ever paid for once — after that it's a static file read.

  Two separate protections on the API quota:
    · a per-visitor limit on *renders* (see api.js), since serving a cached
      clip costs nothing but making a new one does;
    · a global daily budget here, so the whole site can't exhaust the free
      tier no matter how many visitors show up.
*/
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const API = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-2.5-flash-preview-tts";

// The host's register. Prepended to every line; never spoken.
const STYLES = {
  host:
    "You are the host of a big television game show, in front of a live studio " +
    "audience. Say the following with warm, booming, theatrical energy — fast, " +
    "confident and delighted. Do not read these instructions aloud. Say only: ",
  rival:
    "You are a contestant on a television game show, calling out your guess " +
    "with nervous enthusiasm. Do not read these instructions aloud. Say only: ",
  crowd:
    "You are one voice in a excited television studio audience, shouting along " +
    "with everyone else. Do not read these instructions aloud. Shout only: ",
};

// Only these voices may be requested, so a query string can't pick anything odd.
export const VOICES = {
  host: "Puck",
  rival: "Kore",
  crowd: ["Leda", "Aoede"],
};
const ALLOWED = new Set([VOICES.host, VOICES.rival, ...VOICES.crowd]);
const ROLE_OF = new Map([
  [VOICES.host, "host"],
  [VOICES.rival, "rival"],
  ...VOICES.crowd.map((v) => [v, "crowd"]),
]);

/** 24kHz mono 16-bit PCM from the API, wrapped so a browser can decode it. */
function toWav(pcm, rate = 24000) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const today = () => new Date().toISOString().slice(0, 10);

export function createTts({ cacheDir, key, model = DEFAULT_MODEL, dailyBudget = 1000, bundledDir = null }) {
  const dir = path.join(cacheDir, "tts");
  // Clips committed to the repo. Read-only, and checked before the writable
  // cache: hosts without a persistent disk wipe cacheDir on every restart, so
  // without this the server would re-render the whole show each deploy.
  const bundled = bundledDir;
  const budgetFile = path.join(dir, "budget.json");
  let failed = key ? null : "GEMINI_API_KEY is not set";
  let ready = Boolean(key);
  let budget = { day: today(), used: 0 };

  const loadBudget = (async () => {
    await mkdir(dir, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(budgetFile, "utf8"));
      if (saved.day === today()) budget = saved;
    } catch {
      /* first run */
    }
  })();

  const saveBudget = () => writeFile(budgetFile, JSON.stringify(budget)).catch(() => {});

  function spend() {
    if (budget.day !== today()) budget = { day: today(), used: 0 };
    if (budget.used >= dailyBudget) return false;
    budget.used += 1;
    saveBudget();
    return true;
  }

  const hashFor = (text, voice) =>
    createHash("sha1").update(`${model}|${voice}|${text}`).digest("hex");
  const fileFor = (text, voice) => path.join(dir, hashFor(text, voice) + ".wav");
  const bundledFor = (text, voice) =>
    bundled ? path.join(bundled, hashFor(text, voice) + ".wav") : null;

  /** The committed clip for a line, if one was pre-rendered. */
  async function bundledHit(text, voice) {
    const f = bundledFor(text, voice);
    if (!f) return null;
    try {
      await access(f);
      return f;
    } catch {
      return null;
    }
  }

  async function render(text, voice) {
    const role = ROLE_OF.get(voice) || "host";
    const body = JSON.stringify({
      contents: [{ parts: [{ text: STYLES[role] + text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    });

    // The free tier rate-limits per minute; back off rather than give up.
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(`${API}/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body,
      });
      if (res.ok) {
        const data = await res.json();
        const b64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (!b64) throw new Error("no audio in response");
        return toWav(Buffer.from(b64, "base64"));
      }
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1500));
        continue;
      }
      throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 120)}`);
    }
    throw new Error("TTS rate limited");
  }

  // One in-flight render per line, so duplicate requests share the work.
  const pending = new Map();

  async function synth(text, voice) {
    await loadBudget;
    if (!key) throw new Error(failed);
    if (!ALLOWED.has(voice)) throw new Error("Unknown voice");
    const prerendered = await bundledHit(text, voice);
    if (prerendered) return { file: prerendered, cached: true };

    const file = fileFor(text, voice);
    try {
      await access(file);
      return { file, cached: true };
    } catch {
      /* not cached yet */
    }
    if (pending.has(file)) return { file: await pending.get(file), cached: false };

    const job = (async () => {
      if (!spend()) throw new Error("daily voice budget reached");
      const wav = await render(text, voice);
      await writeFile(file, wav);
      return file;
    })();
    pending.set(file, job);
    try {
      return { file: await job, cached: false };
    } finally {
      pending.delete(file);
    }
  }

  return {
    VOICES,
    load: () => loadBudget,
    status: () => ({
      ready,
      loading: false,
      failed,
      budget: { used: budget.used, limit: dailyBudget, day: budget.day },
    }),
    /** Whether this voice is one we're willing to render. */
    knows: (voice) => ALLOWED.has(voice),
    /** True when this line is already on disk — a free request. */
    async isCached(text, voice) {
      if (await bundledHit(text, voice)) return true;
      try {
        await access(fileFor(text, voice));
        return true;
      } catch {
        return false;
      }
    },
    /** Where the pre-render script should write, and what it should name files. */
    hashFor,
    async wav(text, voice) {
      const { file } = await synth(text, voice);
      return readFile(file);
    },
    warm(items) {
      for (const { text, voice } of items) synth(text, voice).catch(() => {});
    },
  };
}
