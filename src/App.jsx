import { useEffect, useState } from "react";
import { DailyScreen, PracticeScreen, dayNumber, load } from "./components/Daily.jsx";
import Show from "./components/Show.jsx";
import { isMuted, setMuted, sfx } from "./lib/sound.js";
import * as voice from "./lib/voice.js";

const route = () => location.hash.replace("#", "") || "home";

export default function App() {
  const [screen, setScreen] = useState(route);

  useEffect(() => {
    const on = () => setScreen(route());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const go = (s) => {
    location.hash = s === "home" ? "" : s;
    setScreen(s);
    window.scrollTo(0, 0);
  };
  const home = () => go("home");

  return (
    <>
      <div className="lights" aria-hidden="true" />
      {screen === "rounds" ? (
        <Show key="rounds" onHome={home} />
      ) : screen === "daily" ? (
        <DailyScreen onHome={home} />
      ) : screen === "practice" ? (
        <PracticeScreen onHome={home} />
      ) : (
        <Home go={go} />
      )}
      <VoicePicker />
    </>
  );
}

function Home({ go }) {
  const day = dayNumber();
  const today = load(`cs-daily-${day}`, null);
  const started = today && (today.strikes > 0 || today.shown?.length > 0);
  const stats = load("cs-stats", { streak: 0, last: 0 });
  const streak = stats.last >= day - 1 ? stats.streak : 0;
  return (
    <main className="stage stage--narrow home">
      <div className="logo">
        <span className="logo__crowd">Crowd</span>
        <span className="logo__says">Says!</span>
      </div>
      <p className="tag">We asked 100 people. Can you guess what they said?</p>

      <div className="menu">
        <button className="card card--gold" onClick={() => go("daily")}>
          <b>Today's Board #{day}</b>
          <span>{started ? "Pick up where you left off, or share your result" : "One question, three strikes. Same board for everyone."}</span>
        </button>
        <button className="card" onClick={() => go("practice")}>
          <b>Practice Mode</b>
          <span>Endless fresh boards, just you and the survey. Nothing counts.</span>
        </button>
        <button className="card" onClick={() => go("rounds")}>
          <b>Round Mode 🎬</b>
          <span>The full show: your family vs. a rival family. Face-offs, steals, double and triple rounds, then Fast Money.</span>
        </button>
      </div>
      {streak > 0 && <p className="stats">🔥 {streak} day streak</p>}
    </main>
  );
}

const ENGINES = [
  { id: "kokoro", label: "Kokoro (studio voices)", note: "Free, open-source, runs on your machine." },
  { id: "browser", label: "Browser voices", note: "Built into your browser. Instant, quality varies." },
  { id: "off", label: "No voices", note: "Subtitles only." },
];

function VoicePicker() {
  const [open, setOpen] = useState(false);
  const [engine, setEngine] = useState(voice.getEngine);
  const [muted, setM] = useState(isMuted);
  const [status, setStatus] = useState(null);

  // Starts the Kokoro model loading as soon as the app opens.
  useEffect(() => {
    if (engine !== "kokoro") return;
    let live = true;
    const poll = async () => {
      const st = await voice.kokoroStatus();
      if (!live) return;
      setStatus(st);
      if (!st.ready && !st.failed) setTimeout(poll, 2000);
    };
    poll();
    return () => {
      live = false;
    };
  }, [engine]);

  const kokoroNote = !status
    ? ""
    : status.ready
      ? "Ready."
      : status.failed
        ? `Unavailable (${status.failed}). Using browser voices.`
        : "Loading the voice model… first time takes ~20s.";

  return (
    <div className="voicepick">
      {open && (
        <div className="voicepick__panel" role="dialog" aria-label="Sound settings">
          <b>Voices</b>
          {ENGINES.map((e) => (
            <label key={e.id} className={"vopt" + (engine === e.id ? " vopt--on" : "")}>
              <input
                type="radio"
                name="engine"
                checked={engine === e.id}
                onChange={() => {
                  voice.setEngine(e.id);
                  setEngine(e.id);
                }}
              />
              <span>
                {e.label}
                <small>{e.id === "kokoro" && engine === "kokoro" && kokoroNote ? kokoroNote : e.note}</small>
              </span>
            </label>
          ))}
          <div className="voicepick__row">
            <button
              className="btn"
              onClick={() => {
                sfx.ding();
                voice.crowd("Good answer!");
              }}
            >
              Test ▶
            </button>
            <button
              className="btn"
              onClick={() => {
                setMuted(!muted);
                setM(!muted);
              }}
            >
              {muted ? "Unmute all" : "Mute all"}
            </button>
          </div>
        </div>
      )}
      <button className="mute" onClick={() => setOpen(!open)} aria-label="Sound settings">
        {muted ? "🔇" : engine === "off" ? "🔈" : "🔊"}
      </button>
    </div>
  );
}
