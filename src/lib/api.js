import { QUESTIONS } from "../data/questions.js";

const json = async (res) => {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

// The hand-written bank is the offline fallback when generation fails.
const fallback = (n) => ({ ...QUESTIONS[((n % QUESTIONS.length) + QUESTIONS.length) % QUESTIONS.length], fallback: true });

export async function fetchDaily(day) {
  try {
    return await json(await fetch(`/api/daily?day=${day}`));
  } catch {
    return fallback(day * 7);
  }
}

export async function fetchSurvey(avoid = [], quick = false) {
  try {
    return await json(
      await fetch("/api/survey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avoid, quick }),
      })
    );
  } catch {
    return fallback(Math.floor(Math.random() * QUESTIONS.length));
  }
}

/** Ask the AI referee whether a guess the fuzzy matcher missed means an answer. */
export async function judgeGuess(q, answers, guess) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const { index } = await json(
      await fetch("/api/judge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q, answers: answers.map((a) => a[0]), guess }),
        signal: ctrl.signal,
      })
    );
    clearTimeout(t);
    return Number.isInteger(index) ? index : -1;
  } catch {
    return -1;
  }
}
