# Crowd Says — native iOS app

A full SwiftUI port of the web game: today's board, practice mode, the whole
show (face-offs, play-or-pass, steals, double/triple rounds) and Fast Money.

## Requirements

**Xcode is required and is not currently installed on this machine** — only the
Command Line Tools are. Install Xcode from the App Store, then:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

The project targets **iOS 17** (it uses `onChange(of:)`'s two-parameter form,
`TimelineView` and `ShareLink`).

## Build and run

```bash
open ios/CrowdSays.xcodeproj
```

Or from the terminal:

```bash
xcodebuild -project ios/CrowdSays.xcodeproj -scheme CrowdSays -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

Set your own signing team in the target's Signing & Capabilities before running
on a device; the bundle id is `com.crowdsays.app`.

## Offline by default, better with the server

The app ships the 36-board question bank from `src/data/questions.js` (converted
to `CrowdSays/Resources/questions.json`), the same forgiving answer matcher, and
iOS's built-in voices — so it is fully playable with no network.

Point it at a running `server/index.js` to get everything the web game has:

- **Settings → Survey server** (the 🔊 button, bottom right), or
- the `CSServerURL` key in `CrowdSays/Info.plist` for a baked-in default.

With a server configured you get AI-written daily and practice boards, the AI
answer referee for guesses the fuzzy matcher misses, and layered Kokoro studio
voices for the host, the rival family and the audience. Every one of those calls
falls back to the bundled bank or an iOS voice if the server can't be reached,
so a dropped connection never blocks a game.

## Layout

| Path | What it is |
| --- | --- |
| `CrowdSays/Models.swift` | `Survey` / `Answer`, decoding both the server's array shape and the bundled object shape |
| `CrowdSays/Theme.swift` | Palette, stage background, shared chrome |
| `CrowdSays/Lib/Match.swift` | The fuzzy answer matcher, a port of `src/lib/match.js` |
| `CrowdSays/Lib/Sound.swift` | Tones, applause and crowd noise synthesised into PCM buffers — no audio files |
| `CrowdSays/Lib/Voice.swift` | Host / rival / audience voices: Kokoro clips or `AVSpeechSynthesizer` |
| `CrowdSays/Lib/API.swift` | `/api/daily`, `/api/survey`, `/api/judge`, `/api/tts`, each with a fallback |
| `CrowdSays/Lib/Store.swift` | Day numbering, daily progress, stats and streaks in `UserDefaults` |
| `CrowdSays/Views/ShowModel.swift` | The episode director — one long async function per round |

## Verified

- The matcher was differential-tested against the JavaScript original across
  **8,950 cases** (every answer and alias in the bank, plus typos, truncations,
  stopwords, punctuation, accents, non-Latin text and emoji): **identical
  results on every one**.
- All 16 sources **typecheck clean** — no errors, no warnings. This was done
  against the macOS SDK (no Xcode here, so no iOS SDK), which reaches
  everything except two iOS-only view modifiers,
  `textInputAutocapitalization` and `keyboardType`; those were stubbed for the
  check and are correct as written for iOS. `AVAudioSession` setup is behind
  `#if os(iOS)` for the same reason.
- `Models.swift` decodes both the bundled bank and a live server payload,
  including the server's `[text, points, aliases]` array form.
- The Xcode project graph was validated: all 16 sources in the compile phase,
  `questions.json` in resources, no dangling references.

Because the macOS SDK stands in for the iOS one, a first build may still turn
up something platform-specific, but the ordinary Swift mistakes are out.
