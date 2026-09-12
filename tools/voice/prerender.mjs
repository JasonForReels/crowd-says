/*
  Pre-renders every line the game can say ahead of time, into server/voice/.
  Those clips are committed, so the server starts fully voiced even on a host
  with no persistent disk — and they cost no API quota ever again.

    node tools/voice/prerender.mjs            # everything
    node tools/voice/prerender.mjs --fixed    # just the host's stock lines

  Safe to re-run: finished clips are skipped, so a run stopped by a rate limit
  or Ctrl-C picks up where it left off.
*/
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { QUESTIONS } from "../../src/data/questions.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(root, "server", "voice");
const MODEL = process.env.TTS_MODEL || "gemini-2.5-flash-preview-tts";
const API = "https://generativelanguage.googleapis.com/v1beta/models";

const VOICES = { host: "Puck", rival: "Kore", crowd: ["Leda", "Aoede"] };
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

// Every line the show says that doesn't depend on a board.
const TARGET = 300;
const fixed = () => {
  const host = [
    "Survey says!",
    "Hands on your buzzers!",
    "Back to the buzzers!",
    "Play or pass?",
    "Let's see what else the survey said.",
    "Time!",
    "Let's see how you did.",
    "Here comes the second half!",
  ];
  for (let r = 1; r <= 6; r++) {
    const mult = r === 3 ? " Double points!" : r >= 4 ? " Triple points!" : "";
    host.push(`Round ${r}.${mult} Top 8 answers on the board.`);
  }
  host.push(`Welcome to Fast Money! Five questions, 20 seconds. You need 200 points.`);
  return [
    ...host.map((text) => ({ role: "host", text })),
    ...["Good answer!", "Steal it!", "You did it!", "Awww!"].map((text) => ({ role: "crowd", text })),
  ];
};

/*
  Priority order, because the free tier only allows a handful of renders a day
  and the bank takes weeks to fill. Lines you hear every single game come
  first, so the show sounds right long before the bank is finished; the rival
  family repeating board answers is the least-heard and comes last.
*/
const tiers = () => [
  ["stock lines", fixed()],
  ["board questions", QUESTIONS.map((q) => ({ role: "host", text: q.q }))],
  ["answers (audience)", QUESTIONS.flatMap((q) => q.a.map(([text]) => ({ role: "crowd", text })))],
];

// Only the first crowd voice is pre-rendered: the client choruses one clip
// into all four layers, so a second voice would double the bank for a
// refinement nobody will notice.
const voicesFor = (role) => (role === "crowd" ? [VOICES.crowd[0]] : [VOICES[role]]);
const hashFor = (text, voice) =>
  createHash("sha1").update(`${MODEL}|${voice}|${text}`).digest("hex");

function key() {
  const env = process.env.GEMINI_API_KEY;
  if (env) return env;
  throw new Error("GEMINI_API_KEY not set — run with it in the environment, or use `node --env-file=.env`");
}

function wav(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function render(text, voice, apiKey) {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: STYLES[Object.entries(VOICES).find(([, v]) =>
      Array.isArray(v) ? v.includes(voice) : v === voice)[0]] + text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  });
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${API}/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body,
    });
    if (res.ok) {
      const d = await res.json();
      const b64 = d?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!b64) throw new Error("no audio in response");
      return wav(Buffer.from(b64, "base64"));
    }
    if (res.status === 429) {
      const detail = await res.text();
      // A per-day quota can't be outwaited, so stop rather than back off for
      // minutes against a limit that only resets tomorrow. A per-minute one
      // is worth retrying.
      if (/PerDay|RequestsPerDay/i.test(detail)) {
        throw new Error("daily quota exhausted");
      }
      const wait = Math.min(60, 2 ** attempt * 3);
      process.stdout.write(`\r  rate limited, waiting ${wait}s…`.padEnd(80));
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (res.status >= 500) {
      const wait = Math.min(60, 2 ** attempt * 3);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 140)}`);
  }
  throw new Error("gave up after repeated rate limits");
}

const BAR = 30;
function bar(done, total, label, t0) {
  const filled = Math.round((BAR * done) / total);
  const pct = ((100 * done) / total).toFixed(1);
  const per = done ? (Date.now() - t0) / done : 0;
  const eta = done ? Math.round(((total - done) * per) / 1000) : 0;
  const mm = String(Math.floor(eta / 60)).padStart(2, "0");
  const ss = String(eta % 60).padStart(2, "0");
  process.stdout.write(
    `\r  [${"█".repeat(filled)}${"·".repeat(BAR - filled)}] ${pct.padStart(5)}%  ` +
      `${done}/${total}  eta ${mm}:${ss}  ${label.slice(0, 28).padEnd(28)}`
  );
}

const main = async () => {
  const apiKey = key();
  await mkdir(OUT, { recursive: true });
  const onlyFixed = process.argv.includes("--fixed");
  // --limit N stops after N *new* clips, for the daily quota.
  const limitArg = process.argv.find((a) => a.startsWith("--limit"));
  const limit = limitArg ? Number(limitArg.split("=")[1] ?? process.argv[process.argv.indexOf(limitArg) + 1]) : Infinity;

  const groups = onlyFixed ? [["stock lines", fixed()]] : tiers();

  // One job per (line, voice), deduplicated, in priority order.
  const jobs = [];
  const seen = new Set();
  for (const [tier, lines] of groups) {
    for (const { role, text } of lines) {
      for (const voice of voicesFor(role)) {
        const h = hashFor(text, voice);
        if (seen.has(h)) continue;
        seen.add(h);
        jobs.push({ tier, text, voice, file: path.join(OUT, `${h}.wav`) });
      }
    }
  }

  // Split into what exists and what still needs rendering.
  const todo = [];
  let have = 0;
  for (const job of jobs) {
    try {
      await access(job.file);
      have += 1;
    } catch {
      todo.push(job);
    }
  }

  console.log(`bank: ${have}/${jobs.length} clips rendered, ${todo.length} to go`);
  if (!todo.length) {
    console.log("nothing to do — the bank is complete.");
    return;
  }
  const batch = todo.slice(0, limit === Infinity ? todo.length : Math.max(0, limit));
  if (!batch.length) {
    console.log("--limit 0, so nothing rendered. Remaining tiers:");
    for (const tier of [...new Set(todo.map((j) => j.tier))]) {
      console.log(`  ${tier}: ${todo.filter((j) => j.tier === tier).length}`);
    }
    return;
  }
  console.log(`this run: up to ${batch.length} clips (next up: ${batch[0].tier})\n`);

  let made = 0;
  const t0 = Date.now();
  for (const job of batch) {
    bar(made, batch.length, job.text, t0);
    try {
      const audio = await render(job.text, job.voice, apiKey);
      await writeFile(job.file, audio);
      made += 1;
      bar(made, batch.length, job.text, t0);
    } catch (e) {
      // Out of quota is the expected way a run ends, not a failure.
      const quota = /quota|429|RESOURCE_EXHAUSTED|exhausted/i.test(e.message);
      console.log(`\n\n${quota ? "daily quota reached" : `stopped: ${e.message}`} after ${made} new clip(s).`);
      console.log(`bank now ${have + made}/${jobs.length}. Re-run tomorrow to continue.`);
      return;
    }
  }

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\n\nrendered ${made} in ${mins} min. Bank now ${have + made}/${jobs.length} -> server/voice/`);
};

main().catch((e) => {
  console.error(`\n\nstopped: ${e.message}\nRe-run to resume — finished clips are kept.`);
  process.exit(1);
});
