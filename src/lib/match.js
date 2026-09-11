// Forgiving answer matching: "spiderman", "Spider-Man" and "spidermen" all hit.

const norm = (s) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\b(the|a|an|my|your|some|their)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const stem = (w) => (w.length > 3 ? w.replace(/ies$/, "y").replace(/(es|s)$/, "") : w);
const key = (s) => norm(s).split(" ").map(stem).join(" ");

function lev(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

// Lower is better; Infinity means no match.
function score(g, c) {
  if (g === c) return 0;
  const gc = g.replace(/ /g, "");
  const cc = c.replace(/ /g, "");
  if (gc === cc) return 0.5; // "spider man" vs "spiderman"
  const gw = g.split(" ");
  const cw = c.split(" ");
  // Whole-word containment either way ("pizza hut" ↔ "pizza").
  if ((cw.length > 1 && g.length >= 3 && cw.includes(g)) || (gw.length > 1 && c.length >= 3 && gw.includes(c)))
    return 1;
  const tol = cc.length <= 4 ? 0 : cc.length <= 7 ? 1 : 2;
  const d = lev(gc, cc);
  return d <= tol ? 1 + d : Infinity;
}

/** Index of the answer the guess matches, or -1. */
export function findAnswer(guess, answers) {
  const g = key(guess);
  if (!g) return -1;
  let best = -1;
  let bestScore = Infinity;
  answers.forEach(([text, , aliases = []], i) => {
    for (const cand of [text, ...aliases]) {
      const s = score(g, key(cand));
      if (s < bestScore) {
        bestScore = s;
        best = i;
      }
    }
  });
  return best;
}
