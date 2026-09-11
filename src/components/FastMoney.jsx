import { useEffect, useReducer, useRef, useState } from "react";
import { judgeGuess } from "../lib/api.js";
import { findAnswer } from "../lib/match.js";
import { sfx } from "../lib/sound.js";
import * as voice from "../lib/voice.js";
import { CountUp, Toast } from "./Board.jsx";

/*
  Fast Money, solo: you play both halves. Five questions, 20 seconds; then
  the same five again in 25 seconds with your first answers covered, and a
  repeated answer gets the double-buzz. 200 points between the two halves wins.
*/

const GOAL = 200;
const TIMES = [20, 25];
const CANCEL = Symbol("cancel");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, "");

export default function FastMoney({ boards, name, onHome }) {
  const [, render] = useReducer((x) => x + 1, 0);
  const S = useRef(null);
  if (!S.current)
    S.current = {
      stage: "loading", // loading | intro | play | reveal | between | done
      qs: null,
      pass: 0,
      ans: [[], []], // per pass, per question: { text, i, pending }
      cells: [[], []], // per pass, per question: { text: bool, pts: bool }
      queue: [],
      deadline: null,
      line: "",
      total: 0,
      won: false,
      toast: null,
    };
  const s = S.current;
  const alive = useRef(true);
  const finish = useRef(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      voice.stopVoices();
    };
  }, []);

  const set = (patch = {}) => {
    if (!alive.current) throw CANCEL;
    Object.assign(s, patch);
    render();
  };
  const wait = async (ms) => {
    await sleep(ms);
    if (!alive.current) throw CANCEL;
  };
  const say = async (text) => {
    set({ line: text });
    await voice.host(text);
    if (!alive.current) throw CANCEL;
  };
  const run = (fn) => () => fn().catch((e) => e !== CANCEL && console.error(e));

  useEffect(() => {
    let live = true;
    boards.then((qs) => {
      if (!live) return;
      Object.assign(s, { qs, stage: "intro" });
      render();
      voice.warm([
        { role: "host", text: `Welcome to Fast Money! Five questions, ${TIMES[0]} seconds. You need ${GOAL} points.` },
        { role: "host", text: "Let's see how you did." },
        { role: "crowd", text: "You did it!" },
        { role: "crowd", text: "Awww!" },
      ]);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boards]);

  async function playPass(p) {
    s.ans[p] = s.qs.map(() => null);
    s.cells[p] = s.qs.map(() => ({ text: false, pts: false }));
    s.queue = s.qs.map((_, k) => k);
    set({ stage: "play", pass: p, deadline: Date.now() + TIMES[p] * 1000, line: "" });

    const ticker = setInterval(() => {
      const left = s.deadline - Date.now();
      if (left > 0 && left < 5500) sfx.tick();
    }, 1000);
    const how = await new Promise((resolve) => {
      finish.current = resolve;
      setTimeout(() => resolve("time"), TIMES[p] * 1000);
    });
    finish.current = null;
    clearInterval(ticker);
    if (!alive.current) throw CANCEL;
    if (how === "time") sfx.timeUp();
    set({ stage: "reveal", deadline: null });
    await wait(700);
    await say(p === 0 ? "Let's see how you did." : "Here comes the second half!");

    for (let k = 0; k < s.qs.length; k++) {
      const a = s.ans[p][k];
      const q = s.qs[k];
      s.cells[p][k].text = true;
      set({ active: k });
      if (!a) {
        await wait(500);
        s.cells[p][k].pts = true;
        set();
        continue;
      }
      await say(`${a.text}. Survey says…`);
      let i = a.i;
      if (i < 0) i = await a.pending;
      a.i = i;
      a.pts = i >= 0 ? q.a[i][1] : 0;
      s.cells[p][k].pts = true;
      s.total += a.pts;
      set();
      if (a.pts > 0) sfx.ding();
      else sfx.buzz();
      await wait(900);
      if (s.total >= GOAL) break;
    }
    set({ active: null });
  }

  const start = run(async () => {
    sfx.applause(2, 0.5);
    await say(`Welcome to Fast Money! Five questions, ${TIMES[0]} seconds. You need ${GOAL} points.`);
    await playPass(0);
    if (s.total >= GOAL) return end();
    set({ stage: "between" });
    await say(
      `${s.total} points. You need ${GOAL - s.total} more. Second half: ${TIMES[1]} seconds, your answers are covered, and no repeats!`
    );
  });

  const second = run(async () => {
    await playPass(1);
    await end();
  });

  async function end() {
    const won = s.total >= GOAL;
    set({ stage: "done", won });
    if (won) {
      sfx.win();
      sfx.applause(4.5, 0.8);
      voice.crowd("You did it!");
      await say(`Congratulations, ${name}! ${s.total} points. You win Fast Money!`);
    } else {
      sfx.groan();
      voice.crowd("Awww!");
      await say(`So close! ${s.total} points. Thanks for playing!`);
    }
  }

  const submit = (text) => {
    if (s.stage !== "play" || !s.queue.length) return;
    const p = s.pass;
    const k = s.queue[0];
    const q = s.qs[k];
    const i = findAnswer(text, q.a);
    if (p === 1) {
      const prev = s.ans[0][k];
      if (prev && (norm(prev.text) === norm(text) || (i >= 0 && i === prev.i))) {
        sfx.dupe();
        set({ toast: { text: "Duplicate answer — try again!", kind: "bad", id: Date.now() } });
        return;
      }
    }
    // Referee in the background so the clock isn't waiting on it.
    s.ans[p][k] = { text, i, pending: i >= 0 ? Promise.resolve(i) : judgeGuess(q.q, q.a, text) };
    voice.warm([{ role: "host", text: `${text}. Survey says…` }]);
    s.queue.shift();
    set();
    if (!s.queue.length) finish.current?.("done");
  };

  const passQ = () => {
    if (s.queue.length > 1) s.queue.push(s.queue.shift());
    set();
  };

  const current = s.qs && s.queue.length ? s.qs[s.queue[0]] : null;

  return (
    <main className="stage fm">
      <header className="bar">
        <button className="link" onClick={onHome}>‹ Leave</button>
        <span className="bar__title">Fast Money</span>
        <span />
      </header>

      <p className="hostline" aria-live="polite">
        <span className="hostline__mic">🎤</span>
        {s.line || "…"}
      </p>

      {s.stage === "loading" && (
        <div className="loading" role="status">
          <div className="loading__dots"><i /><i /><i /></div>
          <p>Writing five fast questions…</p>
        </div>
      )}

      {s.stage === "intro" && (
        <div className="result">
          <p className="result__rank">{GOAL} points to win</p>
          <p className="result__line">
            Five questions, {TIMES[0]} seconds. Answer fast; hit <b>Pass</b> to come back to one. Then you play the
            same five again in {TIMES[1]} seconds.
          </p>
          <div className="row">
            <button className="btn btn--gold btn--big" onClick={start}>Start the clock ⏱</button>
          </div>
        </div>
      )}

      {s.stage === "play" && current && (
        <section className="fm__play">
          <Clock deadline={s.deadline} />
          <h1 className="question">
            <small>Question {s.queue[0] + 1} of 5</small>
            {current.q}
          </h1>
          <FmInput key={`${s.pass}-${s.queue[0]}`} onSubmit={submit} onPass={passQ} />
        </section>
      )}

      {s.qs && s.stage !== "intro" && s.stage !== "loading" && (
        <div className="fmboard">
          {s.qs.map((_, k) => (
            <div key={k} className={"fmrow" + (s.active === k ? " fmrow--on" : "")}>
              {[0, 1].map((p) => {
                const a = s.ans[p][k];
                const c = s.cells[p][k] || {};
                // First-half answers stay covered while the second half is played.
                const covered = p === 0 && s.pass === 1 && s.stage === "play";
                return (
                  <div key={p} className={"fmcell" + (covered ? " fmcell--covered" : "")}>
                    <span className="fmcell__text">{c.text && !covered ? a?.text || "—" : ""}</span>
                    <span className="fmcell__pts">
                      {c.pts && !covered ? <CountUp to={a?.pts || 0} run delay={0} ms={500} /> : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
          <div className="fmtotal">
            <span>Total</span>
            <b>{s.total}</b>
          </div>
        </div>
      )}

      {s.stage === "between" && (
        <div className="row">
          <button className="btn btn--gold btn--big" onClick={second}>Start the second half ⏱</button>
        </div>
      )}

      {s.stage === "done" && (
        <div className="result">
          {s.won && (
            <div className="confetti" aria-hidden="true">
              {Array.from({ length: 50 }, (_, i) => <i key={i} style={{ "--i": i }} />)}
            </div>
          )}
          <p className="result__rank">{s.won ? "You won Fast Money! 💰" : "So close!"}</p>
          <p className="result__line">
            {s.total} of {GOAL} points.
          </p>
          <div className="row">
            <button className="btn btn--gold" onClick={onHome}>Home</button>
          </div>
        </div>
      )}

      <Toast msg={s.toast} />
    </main>
  );
}

function FmInput({ onSubmit, onPass }) {
  const [v, setV] = useState("");
  const ref = useRef(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <form
      className="guess"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) onSubmit(v.trim());
        setV("");
      }}
    >
      <input
        ref={ref}
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder="Answer fast…"
        autoComplete="off"
        spellCheck="false"
        maxLength={40}
      />
      <button type="submit" disabled={!v.trim()}>Go</button>
      <button type="button" className="btn" onClick={onPass}>Pass</button>
    </form>
  );
}

function Clock({ deadline }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((deadline - now) / 1000));
  return <div className={"clock" + (left <= 5 ? " clock--low" : "")}>{left}</div>;
}
