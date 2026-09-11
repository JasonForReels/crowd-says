/*
  Voices for the host, the rival family and the studio audience.

  Engines (all free):
    kokoro  — Kokoro-82M running locally on the dev server. Natural voices, and
              because we get real audio, the "audience" is several voices layered
              with offsets, detune, panning and reverb over a crowd bed.
    browser — the Web Speech API built into every browser. Instant, no download;
              quality depends on the OS. Can't layer, so the crowd is one voice
              over synthesised crowd noise.
    off     — subtitles only.

  Every call resolves when the line has finished, so the game can sequence on it.
  If a Kokoro clip isn't ready in time, that line falls back to the browser voice
  rather than stalling the show.
*/
import { audio, crowdBed, isMuted } from "./sound.js";

export const VOICES = {
  host: "am_michael",
  rival: "af_sarah",
  crowd: ["af_bella", "am_adam", "af_nicole", "am_puck"],
};

const KEY = "cs-voice";
let engine = (() => {
  try {
    return localStorage.getItem(KEY) || "kokoro";
  } catch {
    return "kokoro";
  }
})();
export const getEngine = () => engine;
export function setEngine(e) {
  engine = e;
  try {
    localStorage.setItem(KEY, e);
  } catch {
    /* storage unavailable */
  }
  if (e !== "browser") speechSynthesis?.cancel();
}

export async function kokoroStatus() {
  try {
    return await (await fetch("/api/tts/status")).json();
  } catch {
    return { ready: false, failed: "server unreachable" };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms) => Promise.race([p, sleep(ms).then(() => null)]);

// ── Kokoro ──
const buffers = new Map();
function clip(text, voice) {
  const k = `${voice}|${text}`;
  if (!buffers.has(k)) {
    const p = fetch(`/api/tts?voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(text)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`TTS ${r.status}`);
        return r.arrayBuffer();
      })
      .then((ab) => audio().ctx.decodeAudioData(ab));
    p.catch(() => buffers.delete(k));
    buffers.set(k, p);
  }
  return buffers.get(k);
}

function play(layers) {
  const { ctx, master, room } = audio();
  const now = ctx.currentTime + 0.02;
  let end = 0;
  for (const { buf, delay = 0, rate = 1, gain = 1, pan = 0, wet = true } of layers) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(g).connect(p).connect(master);
    if (wet) p.connect(room);
    src.start(now + delay);
    end = Math.max(end, delay + buf.duration / rate);
  }
  return sleep(end * 1000 + 60);
}

// ── Browser speech ──
let browserVoices = [];
const loadVoices = () => {
  const all = window.speechSynthesis?.getVoices() ?? [];
  const en = all.filter((v) => v.lang?.startsWith("en"));
  // Prefer the higher-quality voices macOS/iOS/Chrome ship when present.
  const rank = (v) => (/(premium|enhanced|natural|google)/i.test(v.name) ? 0 : 1);
  browserVoices = (en.length ? en : all).sort((a, b) => rank(a) - rank(b));
};
if (typeof window !== "undefined" && window.speechSynthesis) {
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
}

function speak(text, role) {
  if (!window.speechSynthesis) return sleep(300);
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const pick = { host: 0, rival: 1, crowd: 2 }[role] ?? 0;
    u.voice = browserVoices[pick % Math.max(1, browserVoices.length)] || null;
    u.rate = role === "crowd" ? 1.12 : 1.02;
    u.pitch = role === "crowd" ? 1.15 : role === "rival" ? 1.1 : 0.95;
    const done = () => resolve();
    u.onend = done;
    u.onerror = done;
    setTimeout(done, 1500 + text.length * 90); // some browsers never fire onend
    speechSynthesis.speak(u);
  });
}

// ── Public API ──
const silent = () => engine === "off" || isMuted();

async function one(role, text, maxWait) {
  if (silent()) return;
  if (engine === "browser") return speak(text, role);
  const buf = await within(clip(text, VOICES[role]).catch(() => null), maxWait);
  if (!buf) return speak(text, role);
  return play([{ buf, gain: role === "host" ? 1.1 : 1 }]);
}

export const host = (text, { maxWait = 3000 } = {}) => one("host", text, maxWait);
export const rival = (text, { maxWait = 2500 } = {}) => one("rival", text, maxWait);

/** The studio audience shouting a line together. */
export async function crowd(text, { maxWait = 3000, level = 1 } = {}) {
  if (silent()) return;
  if (engine === "browser") {
    crowdBed(1.2 + text.length * 0.05, 0.12);
    return speak(text, "crowd");
  }
  const bufs = (
    await within(Promise.all(VOICES.crowd.map((v) => clip(text, v).catch(() => null))), maxWait)
  )?.filter(Boolean);
  if (!bufs?.length) {
    crowdBed(1.2 + text.length * 0.05, 0.12);
    return speak(text, "crowd");
  }
  const offsets = [0, 0.045, 0.1, 0.07];
  const rates = [1, 0.97, 1.04, 1.01];
  const pans = [-0.55, 0.45, 0.1, -0.2];
  const longest = Math.max(...bufs.map((b) => b.duration));
  crowdBed(longest + 0.5, 0.07 * level);
  return play(
    bufs.map((buf, i) => ({ buf, delay: offsets[i], rate: rates[i], pan: pans[i], gain: 0.55 * level }))
  );
}

/** Ask the server to synthesise lines ahead of time (Kokoro only). */
export function warm(lines) {
  if (engine !== "kokoro") return;
  const items = lines.flatMap(({ role, text }) =>
    role === "crowd" ? VOICES.crowd.map((voice) => ({ text, voice })) : [{ text, voice: VOICES[role] }]
  );
  fetch("/api/tts/warm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  }).catch(() => {});
}

export function stopVoices() {
  window.speechSynthesis?.cancel();
}
