import { useEffect, useRef, useState } from "react";
import { dayNumber, load } from "./Daily.jsx";
import { Board } from "./Board.jsx";
import { QUESTIONS } from "../data/questions.js";
import { sfx } from "../lib/sound.js";

const reduced = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/* The curtain only opens on the first visit of a browsing session — nobody
   wants the whole overture again just because they hit Home. */
const seenCurtain = () => {
  try {
    return sessionStorage.getItem("cs-curtain") === "1";
  } catch {
    return true;
  }
};
const markCurtain = () => {
  try {
    sessionStorage.setItem("cs-curtain", "1");
  } catch {
    /* storage unavailable */
  }
};

function Curtain() {
  const [open, setOpen] = useState(() => seenCurtain() || reduced());
  useEffect(() => {
    if (open) return;
    markCurtain();
    const t = setTimeout(() => setOpen(true), 60);
    return () => clearTimeout(t);
  }, [open]);
  // Kept mounted while it animates, then dropped so it can't eat clicks.
  const [gone, setGone] = useState(open);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => setGone(true), 1500);
    return () => clearTimeout(t);
  }, [open]);
  if (gone) return null;
  return (
    <div className={"curtain" + (open ? " curtain--open" : "")} aria-hidden="true">
      <div className="curtain__half curtain__half--l" />
      <div className="curtain__half curtain__half--r" />
    </div>
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
  return (
    <span className="tape__time">
      {p(Math.floor(s / 3600))}:{p(Math.floor((s % 3600) / 60))}:{p(s % 60)}
    </span>
  );
}

/*
  A board that plays itself. Same <Board> the real game uses, so the welcome
  page is showing the actual thing rather than a picture of it. It only runs
  while it is on screen, and shows itself fully open under reduced motion.
*/
const DEMO = QUESTIONS[0];

function DemoBoard() {
  const still = reduced();
  const [shown, setShown] = useState(() => (still ? new Set(DEMO.a.map((_, i) => i)) : new Set()));
  const [live, setLive] = useState(false);
  const host = useRef(null);

  useEffect(() => {
    const el = host.current;
    if (!el || still) return;
    const io = new IntersectionObserver(([e]) => setLive(e.isIntersecting), { threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, [still]);

  useEffect(() => {
    if (!live || still) return;
    const t = setInterval(() => {
      setShown((prev) => {
        if (prev.size >= DEMO.a.length) return new Set();
        return new Set([...prev, prev.size]);
      });
    }, 1500);
    return () => clearInterval(t);
  }, [live, still]);

  return (
    <section className="demo" ref={host} aria-label="Example board">
      <h2 className="sect">Here's a board</h2>
      <p className="question question--demo">
        <small>Survey says</small>
        {DEMO.q}
      </p>
      <Board answers={DEMO.a} shown={shown} />
      <p className="hint">
        Type a guess, the board opens. Three strikes and the round is over.
      </p>
    </section>
  );
}

const STEPS = [
  ["Read the survey", "One question, put to 100 people."],
  ["Guess the answers", "Type what you think they said — close enough counts."],
  ["Beat the board", "Clear all eight before three strikes."],
];

const FEATURES = [
  ["📋", "A new board daily", "Everyone plays the same survey, same day — then compare grids."],
  ["🎙️", "A host who talks", "Studio voices read the question and call out every answer."],
  ["🎬", "The whole show", "Face-offs, steals, double and triple rounds, then Fast Money."],
  ["🔥", "Streaks and ranks", "Your run, your best score, and a spoiler-free grid to share."],
  ["♾️", "Endless practice", "Fresh boards whenever you want. Nothing on the line."],
  ["🚫", "No signup, no ads", "Open it and play. Progress lives on your device."],
];

const MODES = [
  {
    id: "daily",
    n: 1,
    title: "Today's Board",
    blurb: "One survey, three strikes. The same board everyone else is playing.",
    gold: true,
  },
  {
    id: "practice",
    n: 2,
    title: "Practice Mode",
    blurb: "Endless fresh boards, just you and the survey. Nothing counts.",
  },
  {
    id: "rounds",
    n: 3,
    title: "Round Mode",
    blurb: "The full show — your family vs. a rival. Face-offs, steals, then Fast Money.",
  },
];

export default function Home({ go }) {
  const day = dayNumber();
  const today = load(`cs-daily-${day}`, null);
  const started = today && (today.strikes > 0 || today.shown?.length > 0);
  // There is no "finished" flag in storage — a board is over at three strikes
  // or when every answer is on the board.
  const done =
    !!today?.survey &&
    (today.strikes >= 3 || today.shown?.length >= today.survey.a.length);
  const stats = load("cs-stats", { played: 0, streak: 0, best: 0, last: 0 });
  const streak = stats.last >= day - 1 ? stats.streak : 0;

  const [i, setI] = useState(0);
  const [leaving, setLeaving] = useState(null);
  const armed = useRef(false);

  const start = (id) => {
    if (leaving) return;
    sfx.ding();
    setLeaving(id);
    setTimeout(() => go(id), reduced() ? 0 : 380);
  };

  // Arrow keys walk the modes, 1–3 jump straight to one, Enter plays.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "INPUT") return;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") setI((n) => (n + 1) % MODES.length);
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft")
        setI((n) => (n - 1 + MODES.length) % MODES.length);
      else if (e.key >= "1" && e.key <= "3") start(MODES[Number(e.key) - 1].id);
      else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        start(MODES[i].id);
      } else return;
      if (armed.current) sfx.tick();
      armed.current = true;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const dailyLabel = done
    ? "Played — see your result and share it"
    : started
      ? "Pick up where you left off"
      : MODES[0].blurb;

  return (
    <>
      <Curtain />
      <main className={"stage home" + (leaving ? " home--leaving" : "")}>
        <div className="spots" aria-hidden="true">
          <i />
          <i />
        </div>

        {/* Bulb-framed marquee, same trim as the answer board. */}
        <section className="marquee">
          <span className="marquee__bulbs" aria-hidden="true" />
          <div className="onair">
            <i />
            On air · Board #{day}
          </div>

          <div className="logo">
            <span className="logo__crowd">Crowd</span>
            <span className="logo__says">Says!</span>
          </div>

          <p className="tag">We asked 100 people. Can you guess what they said?</p>

          <button className="playbtn" onClick={() => start("daily")}>
            {done ? "See today's result" : started ? "Resume today's board" : "Play today's board"}
          </button>
        </section>

        <div className="menu">
          {MODES.map((m, n) => (
            <button
              key={m.id}
              className={
                "card mode" +
                (m.gold ? " card--gold" : "") +
                (n === i ? " mode--on" : "") +
                (leaving === m.id ? " mode--go" : "")
              }
              style={{ "--d": n }}
              onMouseEnter={() => setI(n)}
              onFocus={() => setI(n)}
              onClick={() => start(m.id)}
            >
              <span className="mode__num" aria-hidden="true">
                {m.n}
              </span>
              <span className="mode__text">
                <b>
                  {m.title}
                  {m.gold && ` #${day}`}
                </b>
                <span>{m.gold ? dailyLabel : m.blurb}</span>
              </span>
              <span className="mode__go" aria-hidden="true">
                ▸
              </span>
            </button>
          ))}
        </div>

        <DemoBoard />

        <section className="sect-block">
          <h2 className="sect">How it works</h2>
          <ol className="steps">
            {STEPS.map(([t, d], n) => (
              <li key={t} style={{ "--d": n }}>
                <span className="steps__n">{n + 1}</span>
                <b>{t}</b>
                <span>{d}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="sect-block">
          <h2 className="sect">What's inside</h2>
          <div className="feats">
            {FEATURES.map(([icon, t, d], n) => (
              <div key={t} className="feat" style={{ "--d": n }}>
                <span className="feat__ico" aria-hidden="true">{icon}</span>
                <b>{t}</b>
                <span>{d}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Second run at the CTA, for anyone who scrolled the whole page. */}
        <section className="closer">
          <p>Ready? Board #{day} is waiting.</p>
          <button className="playbtn" onClick={() => start("daily")}>
            {done ? "See today's result" : started ? "Resume today's board" : "Play today's board"}
          </button>
        </section>

        {/* Scoreboard tape — only the numbers you actually have. */}
        <div className="tape">
          {streak > 0 && (
            <span>
              🔥 <b>{streak}</b> day streak
            </span>
          )}
          {stats.played > 0 && (
            <span>
              <b>{stats.played}</b> played
            </span>
          )}
          {stats.best > 0 && (
            <span>
              best <b>{stats.best}</b>
            </span>
          )}
          <span>
            next board in <Countdown />
          </span>
        </div>

        <p className="keys">
          <kbd>1</kbd>
          <kbd>2</kbd>
          <kbd>3</kbd> pick a mode · <kbd>↵</kbd> play
        </p>
      </main>
    </>
  );
}
