import { useEffect, useRef, useState } from "react";

/*
  The answer board: 8 slots in two columns, like the show. `shown` holds
  revealed indices; `missed` holds ones revealed at the end that nobody got
  (rendered muted). A tile that opens does a full panel rotation with a light
  sweep and counts its points up.
*/
export function Board({ answers, shown, missed = new Set(), onTile, hot = null }) {
  // Column-major order: 1–4 down the left, 5–8 down the right.
  const order = [0, 4, 1, 5, 2, 6, 3, 7];
  return (
    <div className="board">
      {order.map((i) => {
        const ans = answers[i];
        if (!ans) return <div key={i} className="tile tile--empty" />;
        const open = shown.has(i) || missed.has(i);
        return (
          <button
            key={i}
            className={
              "tile" +
              (open ? " tile--open" : "") +
              (missed.has(i) ? " tile--missed" : "") +
              (hot === i ? " tile--hot" : "")
            }
            onClick={() => onTile?.(i)}
            disabled={!onTile || open}
            aria-label={open ? `${ans[0]}, ${ans[1]} points` : `Answer ${i + 1}, hidden`}
          >
            <span className="tile__inner">
              <span className="tile__front">
                <span className="tile__num">{i + 1}</span>
              </span>
              <span className="tile__back">
                <span className="tile__text">{ans[0]}</span>
                <span className="tile__pts">
                  <CountUp to={ans[1]} run={open} />
                </span>
                <span className="tile__glint" />
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Counts 0 → `to` once `run` turns true (after the flip lands). */
export function CountUp({ to, run, delay = 380, ms = 520 }) {
  const [v, setV] = useState(run ? to : 0);
  const was = useRef(run);
  useEffect(() => {
    if (!run) {
      setV(0);
      was.current = false;
      return;
    }
    if (was.current) return setV(to);
    was.current = true;
    let raf;
    const start = performance.now() + delay;
    const step = (now) => {
      const t = Math.min(1, Math.max(0, (now - start) / ms));
      setV(Math.round(to * (1 - Math.pow(1 - t, 3))));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [run, to, delay, ms]);
  return v;
}

/** Big red X's that slam onto the screen, then clear. `n` = how many, `stamp` retriggers. */
export function StrikeFlash({ n, stamp }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!stamp) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 1100);
    return () => clearTimeout(t);
  }, [stamp]);
  if (!visible) return null;
  return (
    <div className="strikeflash" aria-live="assertive">
      {Array.from({ length: Math.max(1, n) }, (_, i) => (
        <span key={i} className="bigx">✕</span>
      ))}
    </div>
  );
}

export function Strikes({ n, max = 3 }) {
  return (
    <div className="strikes" aria-label={`${n} of ${max} strikes`}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={"pip" + (i < n ? " pip--on" : "")}>✕</span>
      ))}
    </div>
  );
}

export function GuessBox({ onGuess, disabled, placeholder = "Type a guess…", label = "Guess", autoFocus = true }) {
  const [v, setV] = useState("");
  const ref = useRef(null);
  useEffect(() => {
    if (!disabled && autoFocus) ref.current?.focus();
  }, [disabled, autoFocus]);
  return (
    <form
      className="guess"
      onSubmit={(e) => {
        e.preventDefault();
        if (!v.trim() || disabled) return;
        onGuess(v.trim());
        setV("");
      }}
    >
      <input
        ref={ref}
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck="false"
        maxLength={60}
      />
      <button type="submit" disabled={disabled || !v.trim()}>
        {label}
      </button>
    </form>
  );
}

export function Toast({ msg }) {
  if (!msg) return null;
  return (
    <div key={msg.id} className={"toast toast--" + msg.kind}>
      {msg.text}
    </div>
  );
}
