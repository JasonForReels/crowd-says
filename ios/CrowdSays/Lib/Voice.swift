import AVFoundation
import Foundation

/*
  Voices for the host, the rival family and the studio audience.

  Engines:
    studio  — Gemini TTS, rendered by the configured server and cached there, so
              a line is only ever generated once. Real audio comes back, so the
              "audience" is several voices layered with offsets, detune, panning
              and reverb over a bed of real crowd noise.
    system  — AVSpeechSynthesizer, built into iOS. Instant and needs no server,
              but robotic; only used when a studio clip can't be had.
    off     — subtitles only.

  Every call returns when the line has finished, so the show can sequence on it.
  If a studio clip isn't ready in time that line falls back to the system voice
  rather than stalling the episode — and logs that it did.
*/

enum VoiceEngine: String, CaseIterable, Identifiable {
    case studio, system, off
    var id: String { rawValue }

    var label: String {
        switch self {
        case .studio: return "Studio voices"
        case .system: return "iPhone voices"
        case .off: return "No voices"
        }
    }

    var note: String {
        switch self {
        case .studio: return "A real host, rival family and audience. Needs the survey server."
        case .system: return "Built into your iPhone. Instant, but robotic."
        case .off: return "Subtitles only."
        }
    }
}

enum VoiceRole {
    case host, rival, crowd

    /*
      Gemini voice names, matching the web game and the server's allowlist —
      the server refuses anything else, and holds the style prompt that gives
      each role its delivery. Chosen on Google's published characteristics:
      Puck is upbeat, Kore firm, Leda and Aoede youthful and breezy.
    */
    var studio: String {
        switch self {
        case .host: return "Puck"
        case .rival: return "Kore"
        case .crowd: return "Leda"
        }
    }

    /*
      Two voices, not four: crowd() choruses whatever arrives into the four
      layers, so a line never waits on every voice before the audience can
      speak.
    */
    static let crowdVoices = ["Leda", "Aoede"]
}

@MainActor
final class Voice: ObservableObject {
    static let shared = Voice()

    @Published var engine: VoiceEngine {
        didSet {
            Store.voiceEngine = engine.rawValue
            if engine != .system { speech.stopSpeaking(at: .immediate) }
        }
    }
    @Published var ttsStatus = TTSStatus()

    private let speech = AVSpeechSynthesizer()
    private let speechDelegate = SpeechDelegate()
    /// Decoded clips, keyed "voice|text" — a line is only ever fetched once.
    private var clips: [String: AVAudioPCMBuffer] = [:]
    private var inFlight: [String: Task<AVAudioPCMBuffer?, Never>] = [:]

    private init() {
        // "kokoro" is the old name for the studio engine.
        let saved = Store.voiceEngine
        engine = VoiceEngine(rawValue: saved == "kokoro" ? "studio" : saved) ?? .studio
        speech.delegate = speechDelegate
    }

    private var silent: Bool { engine == .off || AudioEngine.shared.isMuted }

    // ── Studio clips ──

    private func clip(_ text: String, voice: String) -> Task<AVAudioPCMBuffer?, Never> {
        let key = "\(voice)|\(text)"
        if let buf = clips[key] { return Task { buf } }
        if let existing = inFlight[key] { return existing }

        let task = Task<AVAudioPCMBuffer?, Never> { [weak self] in
            let data = await API.shared.ttsClip(text: text, voice: voice)
            guard let data, let buf = Voice.decodeWav(data) else { return nil }
            await MainActor.run {
                self?.clips[key] = buf
                self?.inFlight[key] = nil
            }
            return buf
        }
        inFlight[key] = task
        return task
    }

    /// AVAudioPCMBuffer can't be built from bytes directly, so the WAV goes
    /// through a temporary file.
    private static func decodeWav(_ data: Data) -> AVAudioPCMBuffer? {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("cs-\(UUID().uuidString).wav")
        defer { try? FileManager.default.removeItem(at: url) }
        guard (try? data.write(to: url)) != nil,
              let file = try? AVAudioFile(forReading: url),
              let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat,
                                         frameCapacity: AVAudioFrameCount(file.length)),
              (try? file.read(into: buf)) != nil
        else { return nil }
        return buf
    }

    /// Waits for a clip, giving up after `maxWait` so the show never stalls.
    private func clip(_ text: String, voice: String, maxWait: Double) async -> AVAudioPCMBuffer? {
        let task = clip(text, voice: voice)
        let timeout = Task<AVAudioPCMBuffer?, Never> {
            try? await Task.sleep(nanoseconds: UInt64(maxWait * 1_000_000_000))
            return nil
        }
        let result = await withTaskGroup(of: AVAudioPCMBuffer?.self) { group -> AVAudioPCMBuffer? in
            group.addTask { await task.value }
            group.addTask { await timeout.value }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
        timeout.cancel()
        return result
    }

    // ── System speech ──

    private func speak(_ text: String, role: VoiceRole) async {
        let u = AVSpeechUtterance(string: text)
        u.rate = role == .crowd ? 0.54 : 0.5
        u.pitchMultiplier = role == .crowd ? 1.15 : (role == .rival ? 1.1 : 0.95)
        u.voice = Voice.systemVoice(for: role)
        await speechDelegate.speak(u, on: speech)
    }

    /// Prefers the higher-quality voices iOS ships when they're installed, and
    /// gives each role a different one where possible.
    private static func systemVoice(for role: VoiceRole) -> AVSpeechSynthesisVoice? {
        let english = AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix("en") }
            .sorted { a, b in
                let rank: (AVSpeechSynthesisVoice) -> Int = { v in
                    if v.quality == .premium { return 0 }
                    if v.quality == .enhanced { return 1 }
                    return 2
                }
                return rank(a) < rank(b)
            }
        guard !english.isEmpty else { return AVSpeechSynthesisVoice(language: "en-US") }
        let slot = [VoiceRole.host: 0, .rival: 1, .crowd: 2][role] ?? 0
        return english[slot % english.count]
    }

    // ── Public API ──

    func host(_ text: String, maxWait: Double = 8.0) async {
        await one(.host, text, maxWait: maxWait)
    }

    func rival(_ text: String, maxWait: Double = 6.0) async {
        await one(.rival, text, maxWait: maxWait)
    }

    /// Falling back used to be silent, which is how the robot voice stayed
    /// hidden for so long.
    private func fellBack(_ role: String, _ text: String) {
        print("[crowd-says] \(role) clip wasn't ready, using the iOS voice: \"\(text)\"")
    }

    private func one(_ role: VoiceRole, _ text: String, maxWait: Double) async {
        guard !silent else { return }
        guard engine == .studio else { return await speak(text, role: role) }
        guard let buf = await clip(text, voice: role.studio, maxWait: maxWait) else {
            fellBack("host", text)
            return await speak(text, role: role)
        }
        await AudioEngine.shared.playAndWait([
            Layer(buffer: buf, gain: role == .host ? 1.1 : 1.0)
        ])
    }

    /*
      The studio audience shouting a line together.

      Four layers built from however many clips actually arrived in time — one
      is enough. Each layer gets its own delay, detune and position, so a
      single voice still reads as a group rather than one person; the spread
      widens when there are fewer distinct voices to work with.
    */
    func crowd(_ text: String, maxWait: Double = 8.0, level: Double = 1) async {
        guard !silent else { return }
        guard engine == .studio else {
            SFX.crowdBed(1.2 + Double(text.count) * 0.05, 0.12)
            return await speak(text, role: .crowd)
        }

        // Waited on together, not one after another: the crowd speaks with
        // what it has rather than holding out for every voice.
        let voices = VoiceRole.crowdVoices
        let bufs: [AVAudioPCMBuffer] = await withTaskGroup(of: (Int, AVAudioPCMBuffer?).self) { group in
            for (i, v) in voices.enumerated() {
                group.addTask { @MainActor in
                    (i, await self.clip(text, voice: v, maxWait: maxWait))
                }
            }
            var out: [(Int, AVAudioPCMBuffer)] = []
            for await (i, buf) in group {
                if let buf { out.append((i, buf)) }
            }
            // Keep the configured voice order, whatever order they arrived in.
            return out.sorted { $0.0 < $1.0 }.map(\.1)
        }

        guard !bufs.isEmpty else {
            fellBack("crowd", text)
            SFX.crowdBed(1.2 + Double(text.count) * 0.05, 0.12)
            return await speak(text, role: .crowd)
        }

        // Wider detune when one voice covers all four parts, so it thickens
        // into a chorus instead of sounding like a flanged solo.
        let solo = bufs.count == 1
        let offsets = solo ? [0.0, 0.07, 0.14, 0.05] : [0.0, 0.045, 0.1, 0.07]
        let rates = solo ? [1.0, 0.93, 1.07, 0.97] : [1.0, 0.97, 1.04, 1.01]
        let pans = [-0.55, 0.45, 0.1, -0.2]
        let longest = bufs.map { Double($0.frameLength) / $0.format.sampleRate }.max() ?? 1
        SFX.crowdBed(longest + 0.5, 0.07 * level)
        await AudioEngine.shared.playAndWait((0..<4).map { i in
            Layer(buffer: bufs[i % bufs.count],
                  delay: offsets[i],
                  rate: rates[i],
                  gain: 0.55 * level,
                  pan: pans[i])
        })
    }

    /// Ask the server to render lines before they are needed.
    func warm(_ lines: [(role: VoiceRole, text: String)]) {
        guard engine == .studio else { return }
        let items = lines.flatMap { line -> [(text: String, voice: String)] in
            line.role == .crowd
                ? VoiceRole.crowdVoices.map { (line.text, $0) }
                : [(line.text, line.role.studio)]
        }
        Task { await API.shared.warm(items) }
    }

    func stop() {
        speech.stopSpeaking(at: .immediate)
        speechDelegate.cancelAll()
    }

    /// Polls the server until voices are available, for the settings panel.
    func refreshStatus() async {
        guard engine == .studio else { return }
        while !Task.isCancelled {
            let st = await API.shared.ttsStatus()
            ttsStatus = st
            if st.ready || st.failed != nil { return }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
    }
}

/// Bridges AVSpeechSynthesizer's delegate callbacks to async/await. Some lines
/// never report finishing, so each one also carries a safety timeout.
private final class SpeechDelegate: NSObject, AVSpeechSynthesizerDelegate {
    // Keyed by identity rather than by the utterance itself, so the safety
    // timeout closure captures something Sendable.
    private var waiting: [ObjectIdentifier: CheckedContinuation<Void, Never>] = [:]
    private let lock = NSLock()

    func speak(_ u: AVSpeechUtterance, on synth: AVSpeechSynthesizer) async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            let key = ObjectIdentifier(u)
            lock.lock()
            waiting[key] = cont
            lock.unlock()
            synth.speak(u)
            // Belt and braces: resume anyway if no callback arrives.
            let cap = 1.5 + Double(u.speechString.count) * 0.09
            DispatchQueue.main.asyncAfter(deadline: .now() + cap) { [weak self] in
                self?.finish(key)
            }
        }
    }

    private func finish(_ key: ObjectIdentifier) {
        lock.lock()
        let cont = waiting.removeValue(forKey: key)
        lock.unlock()
        cont?.resume()
    }

    func cancelAll() {
        lock.lock()
        let all = waiting.values
        waiting.removeAll()
        lock.unlock()
        all.forEach { $0.resume() }
    }

    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        finish(ObjectIdentifier(u))
    }

    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
        finish(ObjectIdentifier(u))
    }
}
