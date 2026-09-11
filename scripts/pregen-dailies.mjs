/*
  Pre-generate daily boards into server/dailies.json so every player gets the
  same board even on hosts that wipe their disk. Resumable: days already in
  the file are kept.

    node scripts/pregen-dailies.mjs [days=60] [startDay=today]
*/
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSurveyService } from "../server/poe.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "server/dailies.json");

const env = Object.fromEntries(
  (await readFile(path.join(root, ".env"), "utf8").catch(() => ""))
    .split("\n")
    .filter((l) => /^\w+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()])
);
const key = process.env.POE_API_KEY || env.POE_API_KEY;
if (!key) throw new Error("POE_API_KEY not set");

// Same day numbering as the client (src/components/Daily.jsx).
const EPOCH = new Date(2026, 0, 1);
const now = new Date();
const today = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - EPOCH) / 86400000) + 1;

const count = Number(process.argv[2]) || 60;
const start = Number(process.argv[3]) || today - 1; // yesterday too, for time zones behind the server

const svc = createSurveyService({ key, model: process.env.POE_MODEL || env.POE_MODEL || "GPT-5-nano", cacheDir: path.join(root, ".cache") });
const boards = JSON.parse(await readFile(out, "utf8").catch(() => "{}"));

// Keep any day that was already served live, so nobody's board changes.
for (let d = start; d < start + count; d++) {
  if (boards[d]) continue;
  const cached = await readFile(path.join(root, `.cache/daily-${d}.json`), "utf8").catch(() => null);
  if (cached) {
    const { day, ...b } = JSON.parse(cached);
    boards[d] = b;
  }
}

const todo = [];
for (let d = start; d < start + count; d++) if (!boards[d]) todo.push(d);
console.log(`${Object.keys(boards).length} boards on file, generating ${todo.length}…`);

const save = () => writeFile(out, JSON.stringify(boards, null, 1));
const questions = () => Object.values(boards).map((b) => b.q);

// A few days at a time; each day is itself 3 drafts + a pick.
while (todo.length) {
  const batch = todo.splice(0, 3);
  await Promise.all(
    batch.map(async (d) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { theme, ...b } = await svc.best(3, questions());
          if (questions().some((q) => q.toLowerCase() === b.q.toLowerCase())) throw new Error("duplicate question");
          boards[d] = b;
          console.log(`day ${d}: ${b.q}`);
          return;
        } catch (e) {
          console.warn(`day ${d} attempt ${attempt + 1} failed: ${e.message}`);
        }
      }
    })
  );
  await save();
}
await save();
console.log(`done: ${Object.keys(boards).length} boards in ${path.relative(root, out)}`);
