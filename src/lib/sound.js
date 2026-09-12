// WebAudio sound kit. The buzzers, dings and flips are synthesised, so there
// are no files for those; the audience reactions are real recordings from
// public/audio (see tools/crowd/). voice.js plays through the same graph.

let ctx = null;
let master = null;
let room = null;

let muted = (() => {
  try {
    return localStorage.getItem("cs-muted") === "1";
  } catch {
    return false;
  }
})();

export const isMuted = () => muted;
export function setMuted(m) {
  muted = m;
  if (master) master.gain.value = m ? 0 : 1;
  try {
    localStorage.setItem("cs-muted", m ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
}

/** The shared context, created on first use (must follow a user gesture). */
export function audio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(ctx.destination);
    // A short synthetic room reverb: makes voices sound like a studio, not a phone.
    room = ctx.createConvolver();
    const len = ctx.sampleRate * 1.6;
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    room.buffer = ir;
    const wet = ctx.createGain();
    wet.gain.value = 0.22;
    room.connect(wet).connect(master);
  }
  if (ctx.state === "suspended") ctx.resume();
  return { ctx, master, room };
}

function tone(freq, start, dur, type = "sine", gain = 0.18) {
  if (muted) return;
  const { ctx, master } = audio();
  const t = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

let noiseBuf = null;
function noise() {
  const { ctx } = audio();
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  return src;
}

/*
  Real studio audiences, cut from freely-licensed recordings (see
  tools/crowd/ATTRIBUTION.md). Synthesised noise can do the texture of a room
  but never the sound of actual people, so reactions play the recordings and
  fall back to the synth below only if a clip can't be loaded.
*/
const SAMPLES = {
  cheer: "/audio/cheer.m4a",
  applause: "/audio/applause.m4a",
  applauseBig: "/audio/applause-big.m4a",
  groan: "/audio/groan.m4a",
};
const loaded = new Map();

function sample(name) {
  if (!loaded.has(name)) {
    const p = fetch(SAMPLES[name])
      .then((r) => {
        if (!r.ok) throw new Error(`audio ${r.status}`);
        return r.arrayBuffer();
      })
      .then((ab) => audio().ctx.decodeAudioData(ab));
    p.catch(() => loaded.delete(name));
    loaded.set(name, p);
  }
  return loaded.get(name);
}

/** Fetch and decode the reactions up front, so the first one isn't late. */
export function preloadCrowd() {
  if (muted) return; // needs a gesture first; called again once unmuted
  for (const name of Object.keys(SAMPLES)) sample(name).catch(() => {});
}

/** Plays a recording at `level`, trimmed to `dur` with a short fade. */
function playSample(name, dur, level, { wet = true } = {}) {
  if (muted) return false;
  const p = loaded.get(name);
  if (!p) {
    sample(name).catch(() => {});
    return false; // not decoded yet — this one uses the synth
  }
  p.then((buf) => {
    if (muted) return;
    const { ctx, master, room } = audio();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    const length = Math.min(dur ?? buf.duration, buf.duration);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.04);
    g.gain.setValueAtTime(level, t + Math.max(0.05, length - 0.4));
    g.gain.linearRampToValueAtTime(0.0001, t + length);
    src.connect(g).connect(master);
    if (wet) g.connect(room);
    src.start(t);
    src.stop(t + length + 0.05);
  }).catch(() => {});
  return true;
}

/** Hundreds of tiny filtered noise bursts read convincingly as a clapping crowd. */
function synthApplause(dur = 2.6, level = 0.5) {
  if (muted) return;
  const { ctx, master, room } = audio();
  const out = ctx.createGain();
  out.gain.value = level;
  out.connect(master);
  out.connect(room);
  const now = ctx.currentTime;
  const claps = Math.floor(dur * 140);
  for (let i = 0; i < claps; i++) {
    const t = now + Math.random() * dur;
    // Fade the density out towards the end.
    const fade = 1 - Math.max(0, (t - now) / dur - 0.55) / 0.45;
    const src = noise();
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 900 + Math.random() * 1800;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.25 * fade, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(bp).connect(g).connect(out);
    src.start(t, Math.random());
    src.stop(t + 0.06);
  }
}

function applause(dur = 2.6, level = 0.5) {
  if (muted) return;
  // A four-second-plus cue is a win, so bring the whole house in.
  const name = dur >= 4 ? "applauseBig" : "applause";
  if (!playSample(name, dur, Math.min(1, level * 1.5))) synthApplause(dur, level);
}

/** Crowd bed: a real audience under the voices, or filtered noise if it's late. */
export function crowdBed(dur = 1.4, level = 0.1, shape = "cheer") {
  if (muted) return;
  if (playSample(shape === "groan" ? "groan" : "cheer", dur, Math.min(1, level * 3.2))) return;
  const { ctx, master } = audio();
  const src = noise();
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = shape === "groan" ? 420 : 1100;
  bp.Q.value = 0.7;
  const g = ctx.createGain();
  const t = ctx.currentTime;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level, t + 0.12);
  g.gain.setValueAtTime(level, t + dur * 0.6);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  if (shape === "groan") {
    bp.frequency.setValueAtTime(520, t);
    bp.frequency.exponentialRampToValueAtTime(260, t + dur);
  }
  src.connect(bp).connect(g).connect(master);
  src.start(t);
  src.stop(t + dur + 0.1);
}

export const sfx = {
  ding() {
    tone(1318, 0, 0.5, "triangle", 0.22);
    tone(1760, 0.09, 0.7, "triangle", 0.18);
  },
  buzz() {
    tone(110, 0, 0.7, "sawtooth", 0.16);
    tone(116, 0, 0.7, "square", 0.08);
  },
  flip() {
    tone(520, 0, 0.08, "square", 0.05);
    tone(880, 0.05, 0.14, "triangle", 0.1);
  },
  dupe() {
    tone(330, 0, 0.12, "square", 0.1);
    tone(330, 0.16, 0.12, "square", 0.1);
  },
  tick() {
    tone(1200, 0, 0.04, "square", 0.05);
  },
  buzzer() {
    // Face-off buzz-in.
    tone(740, 0, 0.25, "square", 0.12);
    tone(988, 0, 0.25, "square", 0.06);
  },
  timeUp() {
    tone(220, 0, 1.2, "sawtooth", 0.14);
    tone(233, 0, 1.2, "square", 0.08);
  },
  win() {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.12, 0.45, "triangle", 0.18));
  },
  applause,
  groan() {
    if (!playSample("groan", 1.8, 0.55)) crowdBed(1.3, 0.16, "groan");
  },
};
