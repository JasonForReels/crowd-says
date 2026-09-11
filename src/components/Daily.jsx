import { useEffect, useMemo, useRef, useState } from "react";
import { fetchDaily, fetchSurvey, judgeGuess } from "../lib/api.js";
import { findAnswer } from "../lib/match.js";
import { sfx } from "../lib/sound.js";
import * as voice from "../lib/voice.js";
import { Board, GuessBox, StrikeFlash, Strikes, Toast } from "./Board.jsx";

const EPOCH = new Date(2026, 0, 1);
const MAX_STRIKES = 3;

export function dayNumber(d = new Date()) {
  const local = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((local - EPOCH) / 86400000) + 1;
}

export const load = (k, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
};

export function rankFor(pct) {
  if (pct >= 100) return "Crowd Whisperer 👑";
  if (pct >= 75) return "Survey Savant 🧠";
  if (pct >= 50) return "Pretty Popular 😎";
  if (pct > 0) return "Hot Take Haver 🌶️";
  return "Certified Contrarian 🙃";
}

const LOADING_LINES = [
  "Polling 100 strangers…",
  "Tallying the clipboard…",
  "Bribing the focus group…",
  "Counting the hands…",
];

function Loading() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % LOADING_LINES.length), 1400);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="loading" role="status">
      <div className="loading__dots"><i /><i /><i /></div>
      <p>{LOADING_LINES[i]}</p>
    </div>
  );
}

// ── Today's board: one AI-written survey per day, same for everyone ──
export function DailyScreen({ onHome }) {
  const day = dayNumber();
  const storeKey = `cs-daily-${day}`;
  const [saved, setSaved] = useState(() => load(storeKey, null));

  useEffect(() => {
    if (saved?.survey) return;
    let live = true;
    fetchDaily(day).then((survey) => live && setSaved({ survey, shown: [], strikes: 0, log: [] }));
    return () => {
      live = false;
    };
  }, [day, saved?.survey]);

  return (
    <Shell title={`Daily #${day}`} onHome={onHome}>
      {!saved?.survey ? (
        <Loading />
      ) : (
        <Game
          survey={saved.survey}
          initial={saved}
          onChange={(s) => save(storeKey, { survey: saved.survey, ...s })}
          result={({ shown, strikes, score, pct }) => (
            <DailyResult day={day} survey={saved.survey} shown={shown} strikes={strikes} score={score} pct={pct} onHome={onHome} />
          )}
        />
      )}
    </Shell>
  );
}

function DailyResult({ day, survey, shown, strikes, score, pct, onHome }) {
  const [copied, setCopied] = useState(false);
  // Record today's result the first time the result shows; idempotent per day.
  const [stats] = useState(() => {
    const st = load("cs-stats", { played: 0, streak: 0, best: 0, last: 0 });
    if (st.last !== day) {
      st.streak = st.last === day - 1 ? st.streak + 1 : 1;
      st.played += 1;
      st.best = Math.max(st.best, score);
      st.last = day;
      save("cs-stats", st);
    }
    return st;
  });
  const share = async () => {
    const grid = survey.a.map((_, i) => (shown.has(i) ? "🟧" : "⬛")).join("");
    const text = `Crowd Says #${day} 📋\n"${survey.q}"\n${grid}\n${score} pts · ${"❌".repeat(strikes) || "no strikes"}\n${rankFor(pct)}\n${location.origin}`;
    try {
      if (navigator.share) await navigator.share({ text });
      else {
        await navigator.clipboard.writeText(text);
        setCopied(true);
      }
    } catch {
      /* share sheet dismissed */
    }
  };
  return (
    <>
      <div className="row">
        <button className="btn btn--gold" onClick={share}>{copied ? "Copied! Go brag" : "Share result"}</button>
        <button className="btn" onClick={onHome}>Home</button>
      </div>
      <p className="stats">🔥 {stats.streak} day streak · {stats.played} played · best {stats.best}</p>
      <Countdown />
    </>
  );
}

// ── Practice: endless fresh AI boards, no rival family, the next one prefetched ──
export function PracticeScreen({ onHome }) {
  const [survey, setSurvey] = useState(null);
  const [round, setRound] = useState(0);
  const [total, setTotal] = useState(0);
  const next = useRef(null);

  const seen = () => load("cs-seen", []);
  const prefetch = () => {
    next.current = fetchSurvey(seen());
    // Voice the next board while this one is being played.
    next.current.then((b) =>
      voice.warm([{ role: "host", text: b.q }, ...b.a.map(([text]) => ({ role: "crowd", text }))])
    );
  };

  const advance = async () => {
    setSurvey(null);
    const p = next.current || fetchSurvey(seen());
    next.current = null;
    const s = await p;
    save("cs-seen", [...seen(), s.q].slice(-30));
    setSurvey(s);
    setRound((r) => r + 1);
    prefetch();
  };

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; // StrictMode mounts twice; generate once
    started.current = true;
    advance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Shell title={`Practice · board ${Math.max(1, round)}`} onHome={onHome}>
      {!survey ? (
        <Loading />
      ) : (
        <Game
          key={round}
          survey={survey}
          readQuestion
          onFinish={(score) => setTotal((t) => t + score)}
          result={() => (
            <>
              <p className="stats">Session total: {total} pts over {round} board{round > 1 ? "s" : ""}</p>
              <div className="row">
                <button className="btn btn--gold btn--big" onClick={advance}>Next question ›</button>
                <button className="btn" onClick={onHome}>Home</button>
              </div>
            </>
          )}
        />
      )}
    </Shell>
  );
}

function Shell({ title, onHome, children }) {
  return (
    <main className="stage">
      <header className="bar">
        <button className="link" onClick={onHome}>‹ Home</button>
        <span className="bar__title">{title}</span>
        <span />
      </header>
      {children}
    </main>
  );
}

// ── One board, three strikes ──
function Game({ survey, initial, onChange, onFinish, result, readQuestion = true }) {
  const [state, setState] = useState(() => ({
    shown: initial?.shown ?? [],
    strikes: initial?.strikes ?? 0,
    log: initial?.log ?? [],
  }));
  const [flash, setFlash] = useState(0);
  const [toast, setToast] = useState(null);
  const [judging, setJudging] = useState(false);

  const shown = useMemo(() => new Set(state.shown), [state.shown]);
  const allFound = shown.size === survey.a.length;
  const done = allFound || state.strikes >= MAX_STRIKES;
  // Opened already finished: show every missed answer. Finishing now: the
  // audience calls them out one at a time (see the finish effect).
  const [called, setCalled] = useState(() => (done ? null : []));
  const missed = useMemo(() => {
    if (!done) return new Set();
    if (called === null) return new Set(survey.a.map((_, i) => i).filter((i) => !shown.has(i)));
    return new Set(called);
  }, [done, survey, shown, called]);
  const score = state.shown.reduce((s, i) => s + survey.a[i][1], 0);
  const maxScore = survey.a.reduce((s, a) => s + a[1], 0);
  const pct = Math.round((score / maxScore) * 100);

  useEffect(() => {
    onChange?.(state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const finished = useRef(done);
  useEffect(() => {
    if (!done || finished.current) return;
    finished.current = true;
    onFinish?.(score);
    if (allFound) {
      sfx.win();
      sfx.applause(3, 0.6);
      return;
    }
    let live = true;
    (async () => {
      await new Promise((r) => setTimeout(r, 1200));
      for (const i of survey.a.map((_, k) => k).filter((k) => !shown.has(k))) {
        if (!live) return;
        sfx.flip();
        setCalled((c) => [...(c || []), i]);
        await new Promise((r) => setTimeout(r, 380));
        await voice.crowd(survey.a[i][0]);
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  // The host reads a fresh board's question aloud.
  const read = useRef(false);
  useEffect(() => {
    if (!readQuestion || done || read.current) return;
    read.current = true;
    voice.host(survey.q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [survey]);

  // Have the audience's lines ready before the game ends.
  useEffect(() => {
    voice.warm([{ role: "crowd", text: "Good answer!" }, ...survey.a.map(([text]) => ({ role: "crowd", text }))]);
  }, [survey]);

  const say = (text, kind = "info") => setToast({ text, kind, id: Date.now() });

  const reveal = (i, text) => {
    if (shown.has(i)) return say(`"${survey.a[i][0]}" is already up there`);
    sfx.flip();
    setTimeout(() => sfx.ding(), 420);
    setState((s) => ({ ...s, shown: [...s.shown, i], log: [...s.log, [text, i]] }));
    say(`Survey says… ${survey.a[i][1]}!`, "good");
    if (shown.size + 1 < survey.a.length) voice.crowd("Good answer!");
  };

  const guess = async (text) => {
    if (done || judging) return;
    if (state.log.some(([t]) => t.toLowerCase() === text.toLowerCase()))
      return say("You already tried that one");
    const local = findAnswer(text, survey.a);
    if (local >= 0) return reveal(local, text);
    // The fuzzy matcher missed. Let the AI referee catch synonyms before we buzz.
    setJudging(true);
    const i = await judgeGuess(survey.q, survey.a, text);
    setJudging(false);
    if (i >= 0) return reveal(i, text);
    sfx.buzz();
    sfx.groan();
    setState((s) => ({ ...s, strikes: s.strikes + 1, log: [...s.log, [text, -1]] }));
    setFlash(Date.now());
  };

  return (
    <>
      <h1 className="question">
        <small>We asked 100 people…</small>
        {survey.q}
      </h1>

      <Board answers={survey.a} shown={shown} missed={missed} />
      <div className="under">
        <Strikes n={state.strikes} />
        <span className="score">{score} <small>pts</small></span>
      </div>

      {!done ? (
        <>
          <GuessBox onGuess={guess} disabled={judging} placeholder={judging ? "Checking with the crowd…" : undefined} />
          {survey.fallback && <p className="hint">Couldn't reach the survey writer, so this is a classic board.</p>}
        </>
      ) : (
        <section className="result">
          <p className="result__rank">{rankFor(pct)}</p>
          <p className="result__line">
            You found {shown.size} of {survey.a.length} answers for <b>{score}</b> of {maxScore} points.
          </p>
          {result({ shown, strikes: state.strikes, score, pct })}
        </section>
      )}

      {state.log.length > 0 && (
        <ul className="log">
          {state.log.map(([t, i], k) => (
            <li key={k} className={i >= 0 ? "log--hit" : "log--miss"}>
              {i >= 0 ? "✓" : "✕"} {t}
            </li>
          ))}
        </ul>
      )}

      <StrikeFlash n={state.strikes} stamp={flash} />
      <Toast msg={toast} />
    </>
  );
}

function Countdown() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const d = new Date(now);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  const s = Math.max(0, Math.floor((next - now) / 1000));
  const p = (n) => String(n).padStart(2, "0");
  return <p className="countdown">Next board in {p(Math.floor(s / 3600))}:{p(Math.floor((s % 3600) / 60))}:{p(s % 60)}</p>;
}
