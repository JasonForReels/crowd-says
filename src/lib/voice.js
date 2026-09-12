/*
  Voices for the host, the rival family and the studio audience.

  Engines:
    studio  — Gemini TTS, rendered by the server and cached to disk, so a line
              is only ever generated once. Real audio comes back, so the
              "audience" is several voices layered with offsets, detune,
              panning and reverb over a bed of real crowd noise.
    browser — the Web Speech API built into every browser. Instant and free,
              but robotic; only used when a studio clip can't be had.
    off     — subtitles only.

  Every call resolves when the line has finished, so the game can sequence on
  it. If a studio clip isn't ready in time that line falls back to the browser
  voice rather than stalling the show — and says so in the console.
*/
import { audio, crowdBed, isMuted } from "./sound.js";

/*
  Gemini voices, chosen on Google's published characteristics: Puck is upbeat
  (the host), Kore firm (the rival family), Leda and Aoede youthful and breezy
  (the audience). The server holds the matching style prompts and only accepts
  these names. Two crowd voices rather than four: crowd() choruses whatever
  arrives into the four layers, so a line never waits on all of them.
*/
export const VOICES = {
  host: "Puck",
  rival: "Kore",
  crowd: ["Leda", "Aoede"],
};

const KEY = "cs-voice";
let engine = (() => {
  try {
    const saved = localStorage.getItem(KEY);
    // "kokoro" is the old name for this engine.
    return !saved || saved === "kokoro" ? "studio" : saved;
  } catch {
    return "studio";
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

export async function ttsStatus() {
  try {
    return await (await fetch("/api/tts/status")).json();
  } catch {
    return { ready: false, failed: "server unreachable" };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms) => Promise.race([p, sleep(ms).then(() => null)]);

// ── Studio clips ──
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

/* Falling back used to be silent, which is how the robot voice hid for so long. */
function fellBack(role, text) {
  console.warn(`[crowd-says] ${role} clip wasn't ready, using the browser voice: "${text}"`);
}

async function one(role, text, maxWait) {
  if (silent()) return;
  if (engine === "browser") return speak(text, role);
  const buf = await within(clip(text, VOICES[role]).catch(() => null), maxWait);
  if (!buf) {
    fellBack(role, text);
    return speak(text, role);
  }
  return play([{ buf, gain: role === "host" ? 1.1 : 1 }]);
}

export const host = (text, { maxWait = 8000 } = {}) => one("host", text, maxWait);
export const rival = (text, { maxWait = 6000 } = {}) => one("rival", text, maxWait);

/*
  The studio audience shouting a line together.

  Four layers, built from however many clips actually arrived in time — one is
  enough. Each layer gets its own delay, detune and position, so a single voice
  still reads as a group of people rather than one person; the spread is wider
  when there are fewer distinct voices to work with.
*/
export async function crowd(text, { maxWait = 8000, level = 1 } = {}) {
  if (silent()) return;
  if (engine === "browser") {
    crowdBed(1.2 + text.length * 0.05, 0.12);
    return speak(text, "crowd");
  }

  // Each clip is waited on separately: the crowd speaks with what it has
  // instead of holding out for all of them.
  const bufs = (
    await Promise.all(VOICES.crowd.map((v) => within(clip(text, v).catch(() => null), maxWait)))
  ).filter(Boolean);

  if (!bufs.length) {
    fellBack("crowd", text);
    crowdBed(1.2 + text.length * 0.05, 0.12);
    return speak(text, "crowd");
  }

  // Wider detune when one voice is doing all four parts, so it thickens into a
  // chorus rather than sounding like a flanged solo.
  const solo = bufs.length === 1;
  const offsets = solo ? [0, 0.07, 0.14, 0.05] : [0, 0.045, 0.1, 0.07];
  const rates = solo ? [1, 0.93, 1.07, 0.97] : [1, 0.97, 1.04, 1.01];
  const pans = [-0.55, 0.45, 0.1, -0.2];
  const longest = Math.max(...bufs.map((b) => b.duration));
  crowdBed(longest + 0.5, 0.07 * level);
  return play(
    offsets.map((delay, i) => ({
      buf: bufs[i % bufs.length],
      delay,
      rate: rates[i],
      pan: pans[i],
      gain: 0.55 * level,
    }))
  );
}

/** Ask the server to render lines before they are needed. */
export function warm(lines) {
  if (engine !== "studio") return;
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
