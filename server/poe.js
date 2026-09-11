/*
  Server-side only: talks to Poe's OpenAI-compatible API with the secret key.
  Never import this from src/ — it would ship the key to the browser.
*/
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ENDPOINT = "https://api.poe.com/v1/chat/completions";

// A random theme per request keeps a small model from asking about the beach
// every single time.
const THEMES = [
  "morning routines", "food and restaurants", "family life", "the workplace", "school days",
  "dating and relationships", "holidays", "pets and animals", "sports", "movies and TV",
  "music", "shopping", "travel and vacations", "the kitchen", "the bathroom", "cars and driving",
  "weddings", "birthdays", "summer", "winter", "technology and phones", "money", "health and the doctor",
  "the gym", "childhood", "grandparents", "neighbors", "things people lie about", "guilty pleasures",
  "things that are annoying", "superstitions", "camping", "the office party", "fast food", "bedtime",
  "things people do when nobody is watching", "cleaning the house", "the grocery store", "airports",
  "social media", "Halloween", "Christmas", "first jobs", "fairy tales", "famous people",
];

const SYSTEM = `You write questions for a family-friendly survey game in the style of classic TV game shows where "we asked 100 people".
Return ONLY a JSON object, no prose, no code fences, in exactly this shape:
{"q":"Name something ...","a":[{"text":"Answer","pts":34,"aliases":["alt spelling","synonym"]}],"wrong":["Plausible miss"]}
Rules:
- "q" is one short, fun question in normal sentence case (not Title Case), usually starting with "Name", that everyday people could answer instantly.
- 6 to 8 answers (never fewer than 6), the most common first, points strictly decreasing, all points add up to between 85 and 100.
- Each "text" is 1 to 3 words, Title Case, and is what a real crowd would say (obvious answers score high).
- 6 to 12 "aliases" per answer covering everything a player might type that a fair host would accept: synonyms, slang, brand names, common phrasings, AND specific kinds or examples (for "Monkey": "gorilla", "chimp", "ape", "baboon"; for "Car Trouble": "flat tire", "dead battery", "breakdown").

- "wrong": 5 believable answers a contestant might blurt out that are NOT on the board and don't mean the same as any board answer (1 to 3 words, Title Case).
- Answers must not overlap each other. Keep it family friendly.`;

async function chat(key, model, messages, { timeoutMs = 45000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Poe ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(t);
  }
}

const extractJson = (s) => {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("No JSON in model reply");
  return JSON.parse(s.slice(start, end + 1));
};

// Turn whatever the model sent into a board we can trust: 5–8 answers,
// descending, deduped, summing to at most 100.
function clean(raw) {
  const q = String(raw?.q ?? "").trim();
  if (!q || q.length > 140) throw new Error("Bad question");
  const seen = new Set();
  let a = (Array.isArray(raw.a) ? raw.a : [])
    .map((x) => ({
      text: String(x?.text ?? "").trim().slice(0, 28),
      pts: Math.max(1, Math.round(Number(x?.pts) || 0)),
      aliases: (Array.isArray(x?.aliases) ? x.aliases : [])
        .map((s) => String(s).trim().slice(0, 40))
        .filter(Boolean)
        .slice(0, 14),
    }))
    .filter((x) => x.text && !seen.has(x.text.toLowerCase()) && seen.add(x.text.toLowerCase()))
    .sort((x, y) => y.pts - x.pts)
    .slice(0, 8);
  if (a.length < 5) throw new Error("Too few answers");
  const sum = a.reduce((s, x) => s + x.pts, 0);
  if (sum > 100) {
    const k = 97 / sum;
    a = a.map((x) => ({ ...x, pts: Math.max(1, Math.floor(x.pts * k)) }));
  }
  const taken = new Set(a.flatMap((x) => [x.text, ...x.aliases]).map((s) => s.toLowerCase()));
  const wrong = (Array.isArray(raw.wrong) ? raw.wrong : [])
    .map((s) => String(s).trim().slice(0, 28))
    .filter((s) => s && !taken.has(s.toLowerCase()))
    .slice(0, 6);
  return { q, a: a.map((x) => [x.text, x.pts, x.aliases]), wrong };
}

export function createSurveyService({ key, model = "GPT-5-nano", cacheDir, dailiesFile }) {
  if (!key) console.warn("[crowd-says] POE_API_KEY is not set — /api routes will fail.");

  async function generate(avoid = []) {
    const theme = THEMES[Math.floor(Math.random() * THEMES.length)];
    const avoidLine = avoid.length
      ? `\nDo not reuse or closely resemble these questions:\n- ${avoid.slice(-15).join("\n- ")}`
      : "";
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const reply = await chat(key, model, [
          { role: "system", content: SYSTEM },
          { role: "user", content: `Theme: ${theme}.${avoidLine}` },
        ]);
        return { ...clean(extractJson(reply)), theme };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  // Nano occasionally writes a garbled question ("Name something people think
  // about money in a hurry"). Draft several in parallel, have it pick the best.
  async function best(n, avoid = []) {
    const drafts = (await Promise.allSettled(Array.from({ length: n }, () => generate(avoid))))
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value);
    if (!drafts.length) throw new Error("All drafts failed");
    if (drafts.length === 1) return drafts[0];
    try {
      const reply = await chat(
        key,
        model,
        [
          {
            role: "system",
            content:
              'You are the producer of a TV survey game show. Pick the question that is the most clear, natural-sounding, fun to guess at, and has the most obvious answers. Reject anything awkward, confusing, or ungrammatical. Reply ONLY with JSON {"best": N}.',
          },
          { role: "user", content: drafts.map((d, i) => `${i}: ${d.q}`).join("\n") },
        ],
        { timeoutMs: 15000 }
      );
      const i = Number(extractJson(reply).best);
      return drafts[Number.isInteger(i) && drafts[i] ? i : 0];
    } catch {
      return drafts[0];
    }
  }

  // One board per calendar day, shared by everyone: generated once, then
  // cached on disk. Concurrent first requests share one generation.
  //
  // Hosts with ephemeral disks (Render's free tier) forget that cache on every
  // restart, which would hand different players different "daily" boards. So
  // boards are pre-generated into server/dailies.json, shipped with the code,
  // and that file wins; live generation only covers days beyond it.
  let bundled = null;
  const loadBundled = async () => {
    if (bundled) return bundled;
    try {
      bundled = dailiesFile ? JSON.parse(await readFile(dailiesFile, "utf8")) : {};
    } catch {
      bundled = {};
    }
    return bundled;
  };

  const inflight = new Map();
  async function daily(day) {
    const shipped = (await loadBundled())[day];
    if (shipped) return { ...shipped, day };
    const file = path.join(cacheDir, `daily-${day}.json`);
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch {
      /* not generated yet */
    }
    if (!inflight.has(day)) {
      inflight.set(
        day,
        (async () => {
          const survey = { ...(await best(3)), day };
          await mkdir(cacheDir, { recursive: true });
          await writeFile(file, JSON.stringify(survey, null, 2));
          return survey;
        })().finally(() => inflight.delete(day))
      );
    }
    return inflight.get(day);
  }

  // Referee for guesses the local fuzzy matcher missed ("puppy" → "Dog").
  async function judge({ q, answers, guess }) {
    const list = answers.map((t, i) => `${i}: ${t}`).join("\n");
    const reply = await chat(
      key,
      model,
      [
        {
          role: "system",
          content: `You are a generous game-show judge. Pick the board answer closest in meaning to the player's guess, then score 0-100 how likely a fair host would accept the guess AS that answer.
Score high (80-100) for: synonyms and rewordings, a specific kind or example of the answer (a gorilla is a kind of monkey for this game; a flat tire is car trouble; a snowstorm is weather), slang, and misspellings.
Score low (0-30) when the guess is a genuinely different thing that is merely related.
Reply ONLY with JSON {"closest": N, "score": S}.`,
        },
        { role: "user", content: `Question: ${q}\nBoard answers:\n${list}\nPlayer guess: ${guess}` },
      ],
      { timeoutMs: 15000 }
    );
    const { closest, score } = extractJson(reply);
    const idx = Number(closest);
    // High bar on purpose: nano's scores are noisy, and accepting a wrong
    // guess feels far worse than missing a synonym. Aliases do the heavy lifting.
    const ok = Number(score) >= 85 && Number.isInteger(idx) && idx >= 0 && idx < answers.length;
    return ok ? idx : -1;
  }

  // quick: one draft, for Fast Money where five boards are needed at once.
  return {
    generate: (avoid, quick) => (quick ? generate(avoid) : best(2, avoid)),
    best,
    daily,
    judge,
  };
}
