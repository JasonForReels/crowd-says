/*
  Free, local text-to-speech with Kokoro-82M (Apache-2.0). The model (~90 MB)
  downloads from Hugging Face on first use and runs on the CPU. Every clip is
  cached to disk, so a line is only ever synthesised once.
*/
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

export function createTts({ cacheDir }) {
  const dir = path.join(cacheDir, "tts");
  let tts = null;
  let loading = null;
  let failed = null;
  let voices = [];

  function load() {
    loading ??= (async () => {
      try {
        const { KokoroTTS } = await import("kokoro-js");
        tts = await KokoroTTS.from_pretrained(MODEL, { dtype: "q8", device: "cpu" });
        voices = Object.keys(tts.voices);
        await mkdir(dir, { recursive: true });
        console.log("[crowd-says] Kokoro voices ready");
      } catch (e) {
        failed = e.message;
        console.error("[crowd-says] Kokoro failed to load:", e.message);
      }
    })();
    return loading;
  }

  // ONNX on the CPU is fastest one job at a time. Live requests jump the
  // queue; warm-up requests wait at the back.
  const queue = [];
  const pending = new Map();
  let busy = false;

  const fileFor = (text, voice) =>
    path.join(dir, createHash("sha1").update(`${voice}|${text}`).digest("hex") + ".wav");

  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const job = queue.shift();
      try {
        const audio = await tts.generate(job.text, { voice: job.voice });
        await writeFile(job.file, Buffer.from(audio.toWav()));
        job.resolve(job.file);
      } catch (e) {
        job.reject(e);
      } finally {
        pending.delete(job.file);
      }
    }
    busy = false;
  }

  async function synth(text, voice, { urgent = false } = {}) {
    await load();
    if (!tts) throw new Error(failed || "TTS unavailable");
    if (!voices.includes(voice)) throw new Error("Unknown voice");
    const file = fileFor(text, voice);
    try {
      await access(file);
      return file;
    } catch {
      /* not cached yet */
    }
    const existing = pending.get(file);
    if (existing) {
      // Promote a queued warm-up job if someone is now waiting on it.
      if (urgent) {
        const i = queue.indexOf(existing.job);
        if (i > 0) queue.unshift(...queue.splice(i, 1));
      }
      return existing.promise;
    }
    let job;
    const promise = new Promise((resolve, reject) => {
      job = { text, voice, file, resolve, reject };
    });
    pending.set(file, { promise, job });
    if (urgent) queue.unshift(job);
    else queue.push(job);
    pump();
    return promise;
  }

  return {
    load,
    status: () => ({ ready: Boolean(tts), loading: Boolean(loading) && !tts && !failed, failed, queued: queue.length }),
    async wav(text, voice) {
      return readFile(await synth(text, voice, { urgent: true }));
    },
    warm(items) {
      for (const { text, voice } of items) synth(text, voice).catch(() => {});
    },
  };
}
