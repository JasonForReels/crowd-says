#!/usr/bin/env python3
"""
Cuts the studio-audience reactions the game plays from freely-licensed source
recordings. See ATTRIBUTION.md for the sources and their licences.

    python3 tools/crowd/build.py <source-dir> public/audio

Each clip is taken from the loudest part of its take, faded, normalised and
written as AAC so every browser can decode it.
"""
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

# name, source stem, seconds of clip, offset from the loudest moment
CLIPS = [
    ("cheer", "hurray_pd", 2.2, -0.6),        # a "good answer" from the crowd
    ("applause", "applause_cc0", 3.0, -0.9),  # taking the bank
    ("applause-big", "bigcrowd_ccby", 5.0, -0.5),  # winning the game
    ("groan", "booing_pd", 2.2, -0.4),        # a strike
]


def read(path: Path):
    with wave.open(str(path)) as w:
        raw = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        return raw.astype(np.float64).reshape(-1, w.getnchannels()) / 32768.0, w.getframerate()


def loudest(mono: np.ndarray, sr: int) -> int:
    win = int(sr * 0.25)
    env = np.convolve(mono, np.ones(win) / win, mode="same")
    return int(np.argmax(env))


def main(src: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for name, stem, seconds, offset in CLIPS:
        x, sr = read(src / f"pcm-{stem}.wav")
        start = max(0, loudest(np.abs(x).mean(axis=1), sr) + int(offset * sr))
        end = min(len(x), start + int(seconds * sr))
        clip = x[start:end].copy()

        # Fade in fast, out slow, so a reaction never clicks.
        fi, fo = int(sr * 0.05), int(sr * 0.45)
        clip[:fi] *= np.linspace(0, 1, fi)[:, None]
        clip[-fo:] *= np.linspace(1, 0, fo)[:, None]
        peak = np.abs(clip).max()
        if peak > 0:
            clip *= 0.9 / peak

        tmp = out / f"{name}.wav"
        with wave.open(str(tmp), "w") as w:
            w.setnchannels(clip.shape[1])
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes((clip * 32767).astype(np.int16).tobytes())

        aac = out / f"{name}.m4a"
        subprocess.run(
            ["afconvert", "-f", "m4af", "-d", "aac", "-b", "96000", str(tmp), str(aac)],
            check=True,
        )
        tmp.unlink()
        print(f"  {name:14} {(end - start) / sr:4.2f}s  {aac.stat().st_size / 1024:5.0f} KB")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
