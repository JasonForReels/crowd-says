import { useEffect, useReducer, useRef, useState } from "react";
import { fetchSurvey, judgeGuess } from "../lib/api.js";
import { findAnswer } from "../lib/match.js";
import { sfx } from "../lib/sound.js";
import * as voice from "../lib/voice.js";
import { Board, GuessBox, StrikeFlash, Strikes, Toast } from "./Board.jsx";
import FastMoney from "./FastMoney.jsx";

/*
  A full episode, solo: you against a computer family.

  Each round: the host reads the question, face-off at the buzzers (top answer
  wins outright, otherwise the higher answer does), the winner chooses play or
  pass, three strikes hands the other family one guess to steal the bank, and
  the audience calls out whatever's left. Points double in round 3 and triple
  after that. First to 300 wins; if that's you, it's on to Fast Money.

  The episode is driven by one async "director" per round. State lives in a
  ref so those long-running functions always see the latest values; render()
  pushes it to the screen.
*/

const TARGET = 300;
const MAX_ROUNDS = 6;
const MULTS = [1, 1, 2, 3, 3, 3];
const RIVALS = ["The Hendersons", "The Garcias", "The Nguyens", "The Okafors", "The Kowalskis", "The Pattersons", "The Castellanos", "The Lindqvists"];
const FILLER = ["Pizza", "Socks", "Grandma", "A Hat", "Money", "Duct Tape", "Bananas", "My Uncle"];
const CANCEL = Symbol("cancel");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const weightedPick = (items, weight) => {
  const total = items.reduce((t, x) => t + weight(x), 0);
  let r = Math.random() * total;
  for (const x of items) if ((r -= weight(x)) <= 0) return x;
  return items[items.length - 1];
};

// Lines every episode uses: synthesise them before they're needed.
voice.warm([
  { role: "host", text: "Survey says!" },
  { role: "host", text: "Hands on your buzzers!" },
  { role: "host", text: "Back to the buzzers!" },
  { role: "host", text: "Play or pass?" },
  { role: "host", text: "Let's see what else the survey said." },
  { role: "crowd", text: "Good answer!" },
  { role: "crowd", text: "Steal it!" },
]);

function warmBoard(b, round) {
  const mult = MULTS[round] ?? 3;
  const m = mult > 1 ? (mult === 2 ? " Double points!" : " Triple points!") : "";
  voice.warm([
    { role: "host", text: `Round ${round + 1}.${m} Top ${b.a.length} answers on the board.` },
    { role: "host", text: b.q },
    ...(b.wrong || []).slice(0, 4).map((text) => ({ role: "rival", text })),
    ...b.a.map(([text]) => ({ role: "rival", text })),
    ...b.a.map(([text]) => ({ role: "crowd", text })),
  ]);
}

function initial(name) {
  return {
    stage: "intro", // intro | loading | round | faceoff | choose | play | cpu | steal | roundEnd | gameOver | fastmoney
    names: [name, RIVALS[Math.floor(Math.random() * RIVALS.length)]],
    scores: [0, 0],
    round: 0,
    board: null,
    qShown: false,
    shown: new Set(),
    missed: new Set(),
    strikes: 0,
    xs: 1,
    bank: 0,
    mult: 1,
    control: null,
    line: "",
    bubble: null,
    input: null, // buzz | answer | play | steal
    deadline: null,
    checking: false,
    flash: 0,
    toast: null,
    hot: null,
    winner: null,
    usedWrong: new Set(),
    seen: [],
    next: null,
    fmBoards: null,
  };
}

export default function Show({ onHome }) {
  const [, render] = useReducer((x) => x + 1, 0);
  const S = useRef(null);
  if (!S.current) {
    let saved = null;
    try {
      saved = localStorage.getItem("cs-family");
    } catch {
      /* storage unavailable */
    }
    S.current = initial(saved || "The Smiths");
  }
  const s = S.current;
  const alive = useRef(true);
  const pendingGuess = useRef(null);
  const pendingChoice = useRef(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      voice.stopVoices();
    };
  }, []);

  // ── primitives the director is built from ──
  const check = () => {
    if (!alive.current) throw CANCEL;
  };
  const set = (patch = {}) => {
    check();
    Object.assign(s, patch);
    render();
  };
  const wait = async (ms) => {
    await sleep(ms);
    check();
  };
  const say = async (text) => {
    set({ line: text });
    await voice.host(text);
    check();
  };
  const rivalSay = async (text) => {
    set({ bubble: text });
    await voice.rival(text);
    check();
  };
  const cheer = async (text) => {
    await voice.crowd(text);
    check();
  };
  const toast = (text, kind = "info") => set({ toast: { text, kind, id: Date.now() } });

  const askGuess = (mode, ms = null) =>
    new Promise((resolve) => {
      pendingGuess.current = resolve;
      set({ input: mode, deadline: ms ? Date.now() + ms : null });
      if (ms)
        setTimeout(() => {
          if (pendingGuess.current !== resolve) return;
          pendingGuess.current = null;
          if (alive.current) set({ input: null, deadline: null });
          resolve(null);
        }, ms);
    });
  const cancelGuess = () => {
    pendingGuess.current = null;
    set({ input: null, deadline: null });
  };
  const onGuess = (text) => {
    const r = pendingGuess.current;
    if (!r) return;
    pendingGuess.current = null;
    set({ input: null, deadline: null });
    r(text);
  };

  const evaluate = async (text) => {
    const b = s.board;
    let i = findAnswer(text, b.a);
    if (i < 0) {
      set({ checking: true });
      i = await judgeGuess(b.q, b.a, text);
      set({ checking: false });
    }
    return i;
  };

  const reveal = async (i) => {
    sfx.flip();
    s.shown = new Set(s.shown).add(i);
    s.bank += s.board.a[i][1];
    set({ hot: i });
    await wait(420);
    sfx.ding();
    await wait(300);
  };

  const strike = async (counts) => {
    sfx.buzz();
    if (counts) s.strikes += 1;
    set({ flash: Date.now(), xs: counts ? s.strikes : 1 });
    sfx.groan();
    await wait(1150);
  };

  const cpuPick = (pHit) => {
    const b = s.board;
    const open = b.a.map((_, i) => i).filter((i) => !s.shown.has(i));
    if (open.length && Math.random() < pHit) {
      const i = weightedPick(open, (k) => b.a[k][1] + 4);
      return { i, text: b.a[i][0] };
    }
    let pool = (b.wrong || []).filter((w) => !s.usedWrong.has(w));
    if (!pool.length) pool = FILLER.filter((w) => !s.usedWrong.has(w));
    const text = pool[Math.floor(Math.random() * pool.length)] || "Uhh… pass";
    s.usedWrong.add(text);
    // A decoy that happens to match a board answer still counts.
    const i = findAnswer(text, b.a);
    return { i: i >= 0 && !s.shown.has(i) ? i : -1, text };
  };

  const award = async (team) => {
    const pts = s.bank * s.mult;
    s.scores = s.scores.map((v, k) => (k === team ? v + pts : v));
    set({ bubble: null, winner: team, awarded: pts });
    sfx.win();
    sfx.applause(2.6, team === 0 ? 0.6 : 0.35);
    await say(`${s.names[team]} take the bank. ${pts} points!`);
  };

  // ── the round, start to finish ──
  async function faceoff() {
    const b = s.board;
    const n = b.a.length;
    for (let attempt = 0; attempt < 3 && s.shown.size < n; attempt++) {
      set({ stage: "faceoff", bubble: null });
      await say(attempt ? "Back to the buzzers!" : "Hands on your buzzers!");
      let cpuTimer;
      const first = await Promise.race([
        askGuess("buzz").then((t) => ({ who: 0, t })),
        new Promise((r) => (cpuTimer = setTimeout(() => r({ who: 1 }), 2200 + Math.random() * 4300))),
      ]);
      clearTimeout(cpuTimer);
      check();
      if (first.who === 1) cancelGuess();
      sfx.buzzer();

      const takeYou = async (t) => {
        if (t == null) {
          toast("Time!", "bad");
          await strike(false);
          return -1;
        }
        const [i] = await Promise.all([evaluate(t), say("Survey says!")]);
        if (i >= 0 && !s.shown.has(i)) {
          await reveal(i);
          return i;
        }
        await strike(false);
        return -1;
      };
      const takeCpu = async () => {
        set({ bubble: "…" });
        await wait(600);
        const pick = cpuPick(0.62);
        await rivalSay(pick.text);
        await say("Survey says!");
        if (pick.i >= 0) {
          await reveal(pick.i);
          return pick.i;
        }
        await strike(false);
        return -1;
      };

      let you;
      let cpu;
      if (first.who === 0) {
        set({ line: `${s.names[0]} buzzed in first!` });
        you = await takeYou(first.t);
        if (you === 0) return 0; // the top answer wins the face-off outright
        cpu = await takeCpu();
      } else {
        await say(`${s.names[1]} buzzed in first!`);
        cpu = await takeCpu();
        if (cpu === 0) return 1;
        await say(`${s.names[0]}, can you beat that?`);
        you = await takeYou(await askGuess("answer", 12000));
      }
      if (you < 0 && cpu < 0) continue;
      const yp = you >= 0 ? b.a[you][1] : -1;
      const cp = cpu >= 0 ? b.a[cpu][1] : -1;
      return yp === cp ? first.who : yp > cp ? 0 : 1;
    }
    return 0;
  }

  async function youPlay() {
    const b = s.board;
    const n = b.a.length;
    set({ stage: "play", control: 0, bubble: null });
    await say(`${s.names[0]}, you're playing. Three strikes and they can steal!`);
    while (s.strikes < 3 && s.shown.size < n) {
      set({ stage: "play" });
      const t = await askGuess("play");
      const already = findAnswer(t, b.a);
      if (already >= 0 && s.shown.has(already)) {
        toast(`"${b.a[already][0]}" is already up there`);
        continue;
      }
      const [i] = await Promise.all([evaluate(t), say("Survey says!")]);
      if (i >= 0 && !s.shown.has(i)) {
        await reveal(i);
        if (s.shown.size < n) await cheer("Good answer!");
      } else await strike(true);
    }
    if (s.shown.size === n) return award(0);

    set({ stage: "steal" });
    await say(`${s.names[1]}, you have one chance to steal!`);
    set({ bubble: "Huddling up…" });
    await wait(2600);
    const pick = cpuPick(0.4);
    await rivalSay(pick.text);
    await say("Survey says!");
    if (pick.i >= 0) {
      await reveal(pick.i);
      return award(1);
    }
    await strike(false);
    return award(0);
  }

  async function cpuPlay() {
    const b = s.board;
    const n = b.a.length;
    set({ stage: "cpu", control: 1 });
    await say(`${s.names[1]} are playing.`);
    while (s.strikes < 3 && s.shown.size < n) {
      set({ bubble: "Thinking…" });
      await wait(800 + Math.random() * 900);
      const pick = cpuPick(Math.max(0.3, 0.82 - 0.1 * s.shown.size));
      await rivalSay(pick.text);
      await say("Survey says!");
      if (pick.i >= 0) {
        await reveal(pick.i);
        if (s.shown.size < n) await cheer("Good answer!");
      } else await strike(true);
    }
    if (s.shown.size === n) return award(1);

    set({ stage: "steal", bubble: null });
    cheer("Steal it!");
    await say(`${s.names[0]}, confer with your family. One guess to steal ${s.bank * s.mult} points!`);
    const t = await askGuess("steal", 25000);
    if (t == null) {
      toast("Time!", "bad");
      await strike(false);
      return award(1);
    }
    const [i] = await Promise.all([evaluate(t), say("Survey says!")]);
    if (i >= 0 && !s.shown.has(i)) {
      await reveal(i);
      await cheer("Good answer!");
      return award(0);
    }
    await strike(false);
    return award(1);
  }

  async function revealRest() {
    const b = s.board;
    const rest = b.a.map((_, i) => i).filter((i) => !s.shown.has(i));
    if (!rest.length) return;
    await say("Let's see what else the survey said.");
    for (const i of rest) {
      sfx.flip();
      s.missed = new Set(s.missed).add(i);
      set({ hot: i });
      await wait(380);
      await cheer(b.a[i][0]); // the audience calls it out
      await wait(200);
    }
    set({ hot: null });
  }

  async function runRound() {
    const r = s.round;
    set({ stage: "loading", line: "", bubble: null, qShown: false, winner: null });
    const b = await s.next;
    check();
    s.seen.push(b.q);
    s.next = fetchSurvey(s.seen);
    s.next.then((nb) => warmBoard(nb, r + 1));
    // Fast Money boards are fetched during the main game, so they're ready.
    if (!s.fmBoards && r === 0) s.fmBoards = Promise.all(Array.from({ length: 5 }, () => fetchSurvey(s.seen, true)));

    Object.assign(s, {
      board: b,
      shown: new Set(),
      missed: new Set(),
      strikes: 0,
      bank: 0,
      mult: MULTS[r] ?? 3,
      usedWrong: new Set(),
      hot: null,
      control: null,
    });
    set({ stage: "round" });
    const m = s.mult > 1 ? (s.mult === 2 ? " Double points!" : " Triple points!") : "";
    await say(`Round ${r + 1}.${m} Top ${b.a.length} answers on the board.`);
    set({ qShown: true });
    await say(b.q);

    const winner = await faceoff();
    if (s.shown.size < b.a.length) {
      let control = winner;
      if (winner === 0) {
        set({ stage: "choose", bubble: null });
        await say("Play or pass?");
        const choice = await new Promise((res) => (pendingChoice.current = res));
        check();
        if (choice === "pass") control = 1;
      }
      if (control === 0) await youPlay();
      else await cpuPlay();
    } else {
      await award(winner);
    }
    await revealRest();

    s.round += 1;
    const [a, c] = s.scores;
    const over = (a >= TARGET || c >= TARGET || s.round >= MAX_ROUNDS) && a !== c;
    if (!over) return set({ stage: "roundEnd" });
    const w = a > c ? 0 : 1;
    set({ stage: "gameOver", winner: w });
    if (w === 0) {
      sfx.applause(4, 0.7);
      await say(`${s.names[0]} win the game! You're going to Fast Money!`);
    } else {
      sfx.groan();
      await say(`${s.names[1]} win the game. Better luck next time!`);
    }
  }

  const run = (fn) => () =>
    fn().catch((e) => {
      if (e !== CANCEL) console.error(e);
    });

  const start = run(async () => {
    try {
      localStorage.setItem("cs-family", s.names[0]);
    } catch {
      /* storage unavailable */
    }
    s.next = fetchSurvey([]);
    s.next.then((b) => warmBoard(b, 0));
    set({ stage: "loading" });
    sfx.applause(2.2, 0.5);
    await say(`Welcome to Crowd Says! Today it's ${s.names[0]} against ${s.names[1]}. First family to ${TARGET} points wins!`);
    await runRound();
  });
  const nextRound = run(runRound);

  if (s.stage === "fastmoney") return <FastMoney boards={s.fmBoards} name={s.names[0]} onHome={onHome} />;

  const inputLabel = { buzz: "Buzz!", answer: "Answer", play: "Guess", steal: "Steal!" }[s.input] || "Guess";
  const playing = ["round", "faceoff", "choose", "play", "cpu", "steal", "roundEnd", "gameOver"].includes(s.stage);

  return (
    <main className="stage show">
      <header className="bar">
        <button className="link" onClick={onHome}>‹ Leave</button>
        <span className="bar__title">
          {s.stage === "intro"
            ? "Round Mode"
            : s.stage === "gameOver"
              ? "Final scores"
              : s.stage === "roundEnd"
                ? `End of round ${s.round}`
                : `Round ${s.round + 1}`}
          {s.mult > 1 && playing && !["roundEnd", "gameOver"].includes(s.stage) && (
            <em className="mult">{s.mult === 2 ? "Double" : "Triple"}</em>
          )}
        </span>
        <span />
      </header>

      {s.stage === "intro" ? (
        <Intro
          name={s.names[0]}
          rival={s.names[1]}
          onName={(v) => set({ names: [v, s.names[1]] })}
          onStart={() => {
            if (!s.names[0].trim()) s.names[0] = "The Smiths";
            start();
          }}
        />
      ) : (
        <>
          <Podiums s={s} />
          <p className="hostline" aria-live="polite">
            <span className="hostline__mic">🎤</span>
            {s.line || "…"}
          </p>

          {s.stage === "loading" && !s.board ? (
            <div className="loading" role="status">
              <div className="loading__dots"><i /><i /><i /></div>
              <p>Surveying 100 people…</p>
            </div>
          ) : s.board ? (
            <>
              <h1 className={"question" + (s.qShown ? "" : " question--hidden")}>
                <small>We asked 100 people…</small>
                {s.qShown ? s.board.q : " "}
              </h1>
              <Board answers={s.board.a} shown={s.shown} missed={s.missed} hot={s.hot} />
              <div className="under">
                <Strikes n={s.strikes} />
                <span className="bankbox" title="Points in the bank">
                  <small>Bank</small>
                  {s.bank}
                  {s.mult > 1 && <em>×{s.mult}</em>}
                </span>
              </div>
            </>
          ) : null}

          <section className="controls">
            {["faceoff", "play", "steal", "cpu", "round"].includes(s.stage) && (
              <>
                <GuessBox
                  onGuess={onGuess}
                  disabled={!s.input || s.checking}
                  label={inputLabel}
                  placeholder={
                    s.checking
                      ? "Checking the survey…"
                      : s.input === "buzz"
                        ? "Type fast and hit Enter to buzz in!"
                        : s.input
                          ? "Type your answer…"
                          : s.stage === "cpu"
                            ? `${s.names[1]} are playing…`
                            : "Wait for it…"
                  }
                />
                {s.deadline && <Timer deadline={s.deadline} />}
              </>
            )}

            {s.stage === "choose" && (
              <div className="row">
                <button className="btn btn--gold btn--big" onClick={() => pendingChoice.current?.("play")}>Play</button>
                <button className="btn btn--big" onClick={() => pendingChoice.current?.("pass")}>Pass</button>
              </div>
            )}

            {s.stage === "roundEnd" && (
              <div className="row">
                <button className="btn btn--gold btn--big" onClick={nextRound}>Next round ›</button>
              </div>
            )}

            {s.stage === "gameOver" && (
              <div className="result">
                <p className="result__rank">{s.winner === 0 ? "You win the game! 🏆" : `${s.names[1]} win`}</p>
                <div className="row">
                  {s.winner === 0 ? (
                    <button className="btn btn--gold btn--big" onClick={() => set({ stage: "fastmoney" })}>
                      Play Fast Money ⏱
                    </button>
                  ) : (
                    <button
                      className="btn btn--gold btn--big"
                      onClick={() => {
                        S.current = initial(s.names[0]);
                        render();
                      }}
                    >
                      Play again
                    </button>
                  )}
                  <button className="btn" onClick={onHome}>Home</button>
                </div>
              </div>
            )}
          </section>
        </>
      )}

      <StrikeFlash n={s.xs} stamp={s.flash} />
      <Toast msg={s.toast} />
    </main>
  );
}

function Intro({ name, rival, onName, onStart }) {
  return (
    <form
      className="setup"
      onSubmit={(e) => {
        e.preventDefault();
        onStart();
      }}
    >
      <h1 className="question">
        <small>Tonight's episode</small>
        Your family vs. {rival}
      </h1>
      <label className="teamfield">
        <span>Your family name</span>
        <input value={name} maxLength={24} onChange={(e) => onName(e.target.value)} />
      </label>
      <ul className="rules">
        <li><b>Face-off:</b> type an answer and hit Enter before the other family buzzes in. The top answer wins outright.</li>
        <li><b>Play or pass:</b> win the face-off and choose who plays the board.</li>
        <li><b>Three strikes</b> and the other family gets one guess to steal the bank.</li>
        <li>Round 3 is <b>double</b>, then <b>triple</b>. First to {TARGET} goes to <b>Fast Money</b>.</li>
      </ul>
      <button className="btn btn--gold btn--big" type="submit">Let's play! 🎬</button>
    </form>
  );
}

function Podiums({ s }) {
  return (
    <div className="podiums">
      {s.names.map((n, i) => (
        <div
          key={i}
          className={
            "podium podium--" + i +
            (s.control === i && (s.stage === "play" || s.stage === "cpu") ? " podium--on" : "") +
            (s.stage === "steal" && s.control !== i ? " podium--on" : "") +
            (s.winner === i && s.stage !== "gameOver" ? " podium--won" : "")
          }
        >
          <span className="podium__name">{i === 0 ? `${n} (you)` : n}</span>
          <b className="podium__score">{s.scores[i]}</b>
          {i === 1 && s.bubble && <span className="bubble">{s.bubble}</span>}
        </div>
      ))}
    </div>
  );
}

function Timer({ deadline }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, deadline - now);
  return (
    <div className="timer">
      <span>{Math.ceil(left / 1000)}</span>
    </div>
  );
}
