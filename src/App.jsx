import { useEffect, useState } from "react";
import { DailyScreen, PracticeScreen } from "./components/Daily.jsx";
import Home from "./components/Home.jsx";
import Show from "./components/Show.jsx";
import { isMuted, preloadCrowd, setMuted, sfx } from "./lib/sound.js";
import * as voice from "./lib/voice.js";

const route = () => location.hash.replace("#", "") || "home";

export default function App() {
  const [screen, setScreen] = useState(route);

  useEffect(() => {
    const on = () => setScreen(route());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  // The audience recordings decode ahead of the first reaction that needs them.
  useEffect(() => {
    preloadCrowd();
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

const ENGINES = [
  { id: "studio", label: "Studio voices", note: "A real host, rival family and audience." },
  { id: "browser", label: "Browser voices", note: "Built into your browser. Instant, but robotic." },
  { id: "off", label: "No voices", note: "Subtitles only." },
];

function VoicePicker() {
  const [open, setOpen] = useState(false);
  const [engine, setEngine] = useState(voice.getEngine);
  const [muted, setM] = useState(isMuted);
  const [status, setStatus] = useState(null);

  // Checks the voice server as soon as the app opens.
  useEffect(() => {
    if (engine !== "studio") return;
    let live = true;
    const poll = async () => {
      const st = await voice.ttsStatus();
      if (!live) return;
      setStatus(st);
      if (!st.ready && !st.failed) setTimeout(poll, 2000);
    };
    poll();
    return () => {
      live = false;
    };
  }, [engine]);

  const studioNote = !status
    ? ""
    : status.ready
      ? "Ready."
      : status.failed
        ? `Unavailable (${status.failed}). Using browser voices.`
        : "Waking the voice server…";

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
                <small>{e.id === "studio" && engine === "studio" && studioNote ? studioNote : e.note}</small>
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
                if (muted) preloadCrowd(); // was muted, so nothing had loaded
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
