import AVFoundation
import Foundation

/*
  The sound kit. Every tone, clap and crowd murmur is synthesised into a PCM
  buffer at runtime, so the app ships no audio files — the same approach
  src/lib/sound.js takes with WebAudio. Voice.swift plays through this graph
  too, which is what puts the host and the studio audience in the same room.
*/

enum Wave { case sine, triangle, square, sawtooth }

/// One component of a sound effect.
struct ToneSpec {
    var freq: Double
    var start: Double = 0
    var dur: Double
    var wave: Wave = .sine
    var gain: Double = 0.18
}

private let sr = 44_100.0

// ── Buffer rendering ──

private func makeBuffer(_ seconds: Double) -> (AVAudioPCMBuffer, UnsafeMutablePointer<Float>)? {
    let frames = AVAudioFrameCount(max(1, seconds * sr))
    guard let fmt = AVAudioFormat(standardFormatWithSampleRate: sr, channels: 1),
          let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frames),
          let data = buf.floatChannelData?[0]
    else { return nil }
    buf.frameLength = frames
    data.update(repeating: 0, count: Int(frames))
    return (buf, data)
}

private func sample(_ wave: Wave, _ phase: Double) -> Double {
    let t = phase - phase.rounded(.down) // 0..<1
    switch wave {
    case .sine: return sin(2 * .pi * t)
    case .square: return t < 0.5 ? 1 : -1
    case .sawtooth: return 2 * t - 1
    case .triangle: return 4 * abs(t - 0.5) - 1
    }
}

enum Synth {
    /// Renders tones that share one buffer, each with the WebAudio envelope:
    /// a 10ms attack then an exponential decay to silence.
    static func tones(_ specs: [ToneSpec]) -> AVAudioPCMBuffer? {
        guard let total = specs.map({ $0.start + $0.dur + 0.05 }).max(),
              let (buf, data) = makeBuffer(total)
        else { return nil }

        for spec in specs {
            let from = Int(spec.start * sr)
            let to = min(Int(buf.frameLength), Int((spec.start + spec.dur) * sr))
            guard to > from else { continue }
            let attack = 0.01 * sr
            for i in from..<to {
                let n = Double(i - from)
                let env: Double
                if n < attack {
                    env = spec.gain * (n / attack)
                } else {
                    // exponentialRampToValueAtTime(0.0001, start + dur)
                    let p = n / (spec.dur * sr)
                    env = spec.gain * pow(0.0001 / max(spec.gain, 0.0001), p)
                }
                data[i] += Float(env * sample(spec.wave, n / sr * spec.freq))
            }
        }
        return buf
    }

    /// Hundreds of tiny filtered noise bursts read convincingly as a clapping
    /// crowd. The density fades towards the end, as it does on the web.
    static func applause(dur: Double = 2.6, level: Double = 0.5) -> AVAudioPCMBuffer? {
        guard let (buf, data) = makeBuffer(dur + 0.2) else { return nil }
        let claps = Int(dur * 140)
        for _ in 0..<claps {
            let at = Double.random(in: 0..<dur)
            let fade = min(1, max(0, 1 - max(0, at / dur - 0.55) / 0.45))
            let start = Int(at * sr)
            let len = Int(0.05 * sr)
            // A single-pole bandpass on white noise, cheap and close enough.
            let f = Double.random(in: 900...2700) / sr
            var prev = 0.0
            var band = 0.0
            for i in 0..<len {
                let idx = start + i
                if idx >= Int(buf.frameLength) { break }
                let white = Double.random(in: -1...1)
                band += f * (white - prev - band)
                prev += f * band
                let env = 0.25 * fade * pow(0.0001 / 0.25, Double(i) / Double(len))
                data[idx] += Float(prev * env * level * 2)
            }
        }
        return buf
    }

    /// Linear-resamples a buffer to detune it. AVAudioPlayerNode has no rate
    /// control, so a layered crowd is built by resampling each voice instead.
    static func resample(_ buf: AVAudioPCMBuffer, rate: Double) -> AVAudioPCMBuffer {
        guard abs(rate - 1) > 0.001, rate > 0,
              let src = buf.floatChannelData
        else { return buf }
        let channels = Int(buf.format.channelCount)
        let inFrames = Int(buf.frameLength)
        let outFrames = Int(Double(inFrames) / rate)
        guard outFrames > 1,
              let out = AVAudioPCMBuffer(pcmFormat: buf.format, frameCapacity: AVAudioFrameCount(outFrames)),
              let dst = out.floatChannelData
        else { return buf }
        out.frameLength = AVAudioFrameCount(outFrames)
        for ch in 0..<channels {
            for i in 0..<outFrames {
                let pos = Double(i) * rate
                let i0 = min(inFrames - 1, Int(pos))
                let i1 = min(inFrames - 1, i0 + 1)
                let frac = Float(pos - Double(i0))
                dst[ch][i] = src[ch][i0] * (1 - frac) + src[ch][i1] * frac
            }
        }
        return out
    }

    /// Crowd bed: bandpassed noise with a wobbling envelope, under the voices.
    static func crowdBed(dur: Double = 1.4, level: Double = 0.1, groan: Bool = false) -> AVAudioPCMBuffer? {
        guard let (buf, data) = makeBuffer(dur + 0.1) else { return nil }
        let frames = Int(buf.frameLength)
        var prev = 0.0
        var band = 0.0
        for i in 0..<frames {
            let t = Double(i) / sr
            // A groan slides the voice of the room down as it fades.
            let center = groan ? 520 * pow(260.0 / 520.0, min(1, t / dur)) : 1100.0
            let f = center / sr
            let white = Double.random(in: -1...1)
            band += f * (white - prev - band)
            prev += f * band

            let env: Double
            if t < 0.12 {
                env = level * (t / 0.12)
            } else if t < dur * 0.6 {
                env = level
            } else {
                let p = min(1, (t - dur * 0.6) / max(0.0001, dur * 0.4))
                env = level * pow(0.0001 / max(level, 0.0001), p)
            }
            data[i] = Float(prev * env * 3)
        }
        return buf
    }
}

// ── The engine ──

/// One layer of a scheduled playback.
struct Layer {
    var buffer: AVAudioPCMBuffer
    var delay: Double = 0
    var rate: Double = 1
    var gain: Double = 1
    var pan: Double = 0
    /// Whether this layer also feeds the room reverb.
    var wet: Bool = true
}

final class AudioEngine {
    static let shared = AudioEngine()

    private let engine = AVAudioEngine()
    private let dry = AVAudioMixerNode()
    private let wet = AVAudioMixerNode()
    private let reverb = AVAudioUnitReverb()
    private let lock = NSLock()
    private var started = false

    var isMuted: Bool = Store.isMuted {
        didSet {
            Store.isMuted = isMuted
            dry.outputVolume = isMuted ? 0 : 1
            wet.outputVolume = isMuted ? 0 : 0.22
        }
    }

    private init() {}

    /// Configures the audio session and graph on first use. Playback mode so
    /// the show keeps talking when the phone is on silent.
    func start() {
        lock.lock()
        defer { lock.unlock() }
        guard !started else { return }
        started = true

        #if os(iOS)
        // Playback category, so the show keeps talking when the ringer is off.
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, options: [])
        try? session.setActive(true)
        #endif

        engine.attach(dry)
        engine.attach(wet)
        engine.attach(reverb)
        reverb.loadFactoryPreset(.mediumRoom)
        reverb.wetDryMix = 100

        let fmt = AVAudioFormat(standardFormatWithSampleRate: sr, channels: 2)
        engine.connect(dry, to: engine.mainMixerNode, format: fmt)
        engine.connect(wet, to: reverb, format: fmt)
        engine.connect(reverb, to: engine.mainMixerNode, format: fmt)
        wet.outputVolume = isMuted ? 0 : 0.22 // matches the web's wet gain
        dry.outputVolume = isMuted ? 0 : 1

        engine.prepare()
        try? engine.start()
    }

    /// Schedules every layer and returns how long the whole thing runs.
    @discardableResult
    func play(_ layers: [Layer]) -> Double {
        guard !isMuted, !layers.isEmpty else { return 0 }
        start()
        guard engine.isRunning else { return 0 }

        var end = 0.0
        for layer in layers {
            let buffer = Synth.resample(layer.buffer, rate: layer.rate)
            let node = AVAudioPlayerNode()
            engine.attach(node)
            let fmt = buffer.format
            // One output bus feeding both mixers: a second connect() call would
            // replace this connection rather than add to it.
            var points = [AVAudioConnectionPoint(node: dry, bus: dry.nextAvailableInputBus)]
            if layer.wet {
                points.append(AVAudioConnectionPoint(node: wet, bus: wet.nextAvailableInputBus))
            }
            engine.connect(node, to: points, fromBus: 0, format: fmt)
            node.volume = Float(layer.gain)
            node.pan = Float(layer.pan)

            let duration = Double(buffer.frameLength) / fmt.sampleRate
            end = max(end, layer.delay + duration)

            node.scheduleBuffer(buffer, at: nil, options: []) { [weak self] in
                // Detach on the main actor once the buffer has drained.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    guard let self else { return }
                    node.stop()
                    self.engine.detach(node)
                }
            }
            if layer.delay > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + layer.delay) { node.play() }
            } else {
                node.play()
            }
        }
        return end
    }

    /// Plays and waits for the sound to finish, so the show can sequence on it.
    func playAndWait(_ layers: [Layer]) async {
        let end = play(layers)
        guard end > 0 else { return }
        try? await Task.sleep(nanoseconds: UInt64((end + 0.06) * 1_000_000_000))
    }

    func one(_ buffer: AVAudioPCMBuffer?, gain: Double = 1, wet: Bool = false) {
        guard let buffer else { return }
        play([Layer(buffer: buffer, gain: gain, wet: wet)])
    }
}

/*
  Real studio audiences, cut from freely-licensed recordings (see
  tools/crowd/ATTRIBUTION.md) and bundled with the app. Synthesised noise can
  do the texture of a room but never the sound of actual people, so reactions
  play the recordings and fall back to the synth only if one is missing.
*/
enum CrowdSample: String, CaseIterable {
    case cheer, applause, groan
    case applauseBig = "applause-big"

    /// Decoded once and kept: four short clips is nothing to hold in memory.
    private static var cache: [CrowdSample: AVAudioPCMBuffer] = [:]
    private static let lock = NSLock()

    var buffer: AVAudioPCMBuffer? {
        CrowdSample.lock.lock()
        defer { CrowdSample.lock.unlock() }
        if let hit = CrowdSample.cache[self] { return hit }
        guard let url = Bundle.main.url(forResource: rawValue, withExtension: "m4a"),
              let file = try? AVAudioFile(forReading: url),
              let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat,
                                         frameCapacity: AVAudioFrameCount(file.length)),
              (try? file.read(into: buf)) != nil
        else { return nil }
        CrowdSample.cache[self] = buf
        return buf
    }

    /// Decodes every clip up front, so the first reaction isn't late.
    static func preload() {
        Task.detached(priority: .utility) {
            for s in CrowdSample.allCases { _ = s.buffer }
        }
    }
}

// ── The kit, pre-rendered once ──

enum SFX {
    // These never change, so they're built on first use and reused.
    private static let dingBuf = Synth.tones([
        ToneSpec(freq: 1318, dur: 0.5, wave: .triangle, gain: 0.22),
        ToneSpec(freq: 1760, start: 0.09, dur: 0.7, wave: .triangle, gain: 0.18),
    ])
    private static let buzzBuf = Synth.tones([
        ToneSpec(freq: 110, dur: 0.7, wave: .sawtooth, gain: 0.16),
        ToneSpec(freq: 116, dur: 0.7, wave: .square, gain: 0.08),
    ])
    private static let flipBuf = Synth.tones([
        ToneSpec(freq: 520, dur: 0.08, wave: .square, gain: 0.05),
        ToneSpec(freq: 880, start: 0.05, dur: 0.14, wave: .triangle, gain: 0.1),
    ])
    private static let dupeBuf = Synth.tones([
        ToneSpec(freq: 330, dur: 0.12, wave: .square, gain: 0.1),
        ToneSpec(freq: 330, start: 0.16, dur: 0.12, wave: .square, gain: 0.1),
    ])
    private static let tickBuf = Synth.tones([ToneSpec(freq: 1200, dur: 0.04, wave: .square, gain: 0.05)])
    private static let buzzerBuf = Synth.tones([
        ToneSpec(freq: 740, dur: 0.25, wave: .square, gain: 0.12),
        ToneSpec(freq: 988, dur: 0.25, wave: .square, gain: 0.06),
    ])
    private static let timeUpBuf = Synth.tones([
        ToneSpec(freq: 220, dur: 1.2, wave: .sawtooth, gain: 0.14),
        ToneSpec(freq: 233, dur: 1.2, wave: .square, gain: 0.08),
    ])
    private static let winBuf = Synth.tones(
        [523.0, 659, 784, 1047].enumerated().map { i, f in
            ToneSpec(freq: f, start: Double(i) * 0.12, dur: 0.45, wave: .triangle, gain: 0.18)
        }
    )

    static func ding() { AudioEngine.shared.one(dingBuf, gain: 1) }
    static func buzz() { AudioEngine.shared.one(buzzBuf) }
    static func flip() { AudioEngine.shared.one(flipBuf) }
    static func dupe() { AudioEngine.shared.one(dupeBuf) }
    static func tick() { AudioEngine.shared.one(tickBuf) }
    static func buzzer() { AudioEngine.shared.one(buzzerBuf) }
    static func timeUp() { AudioEngine.shared.one(timeUpBuf) }
    static func win() { AudioEngine.shared.one(winBuf, wet: true) }

    /// Plays a recorded reaction, or returns false so the caller can synthesise.
    private static func reaction(_ s: CrowdSample, level: Double) -> Bool {
        guard let buf = s.buffer else { return false }
        AudioEngine.shared.play([Layer(buffer: buf, gain: min(1, level), wet: true)])
        return true
    }

    static func applause(_ dur: Double = 2.6, _ level: Double = 0.5) {
        guard !AudioEngine.shared.isMuted else { return }
        // A four-second-plus cue is a win, so bring the whole house in.
        if reaction(dur >= 4 ? .applauseBig : .applause, level: level * 1.5) { return }
        Task.detached(priority: .userInitiated) {
            let buf = Synth.applause(dur: dur, level: level)
            await MainActor.run { AudioEngine.shared.one(buf, wet: true) }
        }
    }

    static func crowdBed(_ dur: Double = 1.4, _ level: Double = 0.1, groan: Bool = false) {
        guard !AudioEngine.shared.isMuted else { return }
        if reaction(groan ? .groan : .cheer, level: level * 3.2) { return }
        Task.detached(priority: .userInitiated) {
            let buf = Synth.crowdBed(dur: dur, level: level, groan: groan)
            await MainActor.run { AudioEngine.shared.one(buf) }
        }
    }

    static func groan() {
        guard !AudioEngine.shared.isMuted else { return }
        if reaction(.groan, level: 0.55) { return }
        crowdBed(1.3, 0.16, groan: true)
    }
}
