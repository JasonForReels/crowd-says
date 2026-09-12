#!/usr/bin/env python3
"""
Exercises the voice route's protections against a running server, with a live
progress bar.

    python3 tools/voice/check_limits.py [base-url]

Checks, in order: a cache miss renders, a cache hit is free, an unknown voice
is refused, the global daily budget stops renders, and a visitor's render
allowance is separate from their (much larger) playback allowance.
"""
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8811"
BAR = 34


def bar(done: int, total: int, label: str) -> None:
    filled = int(BAR * done / max(1, total))
    pct = 100 * done / max(1, total)
    sys.stdout.write(f"\r  [{'█' * filled}{'·' * (BAR - filled)}] {pct:5.1f}%  {label:<44}")
    sys.stdout.flush()


def get(path: str):
    """Returns (status, bytes-or-json)."""
    try:
        with urllib.request.urlopen(BASE + path, timeout=180) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def tts(text: str, voice: str = "Puck"):
    q = urllib.parse.urlencode({"text": text, "voice": voice})
    return get(f"/api/tts?{q}")


def status():
    _, body = get("/api/tts/status")
    return json.loads(body)


def check(name: str, ok: bool, detail: str = "") -> bool:
    print(f"\r  {'PASS' if ok else 'FAIL'}  {name:<46} {detail}")
    return ok


def main() -> int:
    st = status()
    limit = st["budget"]["limit"]
    print(f"server: {BASE}   budget: {st['budget']['used']}/{limit} used today\n")
    results = []

    # 1. cache miss
    bar(0, 1, "rendering a new line (this one is slow)")
    t = time.time()
    code, body = tts("Survey says! Top eight answers on the board.")
    miss = time.time() - t
    results.append(check("renders a new line", code == 200 and len(body) > 10000,
                         f"{code}, {len(body) / 1024:.0f}KB in {miss:.1f}s"))

    # 2. cache hit
    bar(0, 1, "re-requesting the same line")
    t = time.time()
    code, body = tts("Survey says! Top eight answers on the board.")
    hit = time.time() - t
    results.append(check("serves it from cache", code == 200 and hit < miss / 10,
                         f"{hit * 1000:.0f}ms vs {miss * 1000:.0f}ms  ({miss / max(hit, 1e-6):.0f}x faster)"))

    # 3. allowlist
    code, _ = tts("hello", voice="NotARealVoice")
    results.append(check("refuses an unknown voice", code == 400, f"HTTP {code}"))

    # 4. the global daily budget
    st = status()
    room = max(0, st["budget"]["limit"] - st["budget"]["used"])
    print(f"\n  spending the remaining budget ({room} renders) to prove it stops:")
    blocked_at = None
    for i in range(room + 2):
        bar(i, room + 2, f"render {i + 1} of {room + 2}")
        code, _ = tts(f"Budget probe line number {i} at {int(time.time())}")
        if code != 200:
            blocked_at = (i, code)
            break
    st = status()
    results.append(check("daily budget blocks further renders",
                         blocked_at is not None,
                         f"blocked at render {blocked_at[0] + 1} with HTTP {blocked_at[1]}"
                         if blocked_at else f"never blocked ({st['budget']['used']}/{st['budget']['limit']})"))

    # 5. cached playback still works once the budget is gone
    code, body = tts("Survey says! Top eight answers on the board.")
    results.append(check("cached clips still play when out of budget",
                         code == 200 and len(body) > 10000, f"HTTP {code}"))

    print(f"\n{sum(results)}/{len(results)} passed")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
