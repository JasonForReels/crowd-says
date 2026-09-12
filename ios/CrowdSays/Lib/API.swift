import Foundation

/*
  The survey writer. Boards come from the server's /api routes when one is
  configured; every call falls back to the bundled bank rather than throwing,
  so the game is always playable — same contract as src/lib/api.js.
*/

struct TTSStatus: Codable {
    var ready = false
    var loading = false
    var failed: String?
}

actor API {
    static let shared = API()

    private let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 20
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    /// nil when no server is configured — the app then runs fully offline.
    private var base: URL? {
        let raw = Store.serverURL
        guard !raw.isEmpty else { return nil }
        return URL(string: raw.hasSuffix("/") ? String(raw.dropLast()) : raw)
    }

    var isOnline: Bool { base != nil }

    private func url(_ path: String) -> URL? {
        guard let base else { return nil }
        return URL(string: base.absoluteString + path)
    }

    private func fetch<T: Decodable>(_ type: T.Type, _ req: URLRequest) async throws -> T {
        let (data, res) = try await session.data(for: req)
        guard let http = res as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func post(_ path: String, _ body: [String: Any]) -> URLRequest? {
        guard let u = url(path) else { return nil }
        var r = URLRequest(url: u)
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try? JSONSerialization.data(withJSONObject: body)
        return r
    }

    /// Today's board — the same survey everyone else is playing.
    func daily(day: Int) async -> Survey {
        guard let u = url("/api/daily?day=\(day)") else { return QuestionBank.board(day * 7) }
        do {
            return try await fetch(Survey.self, URLRequest(url: u))
        } catch {
            return QuestionBank.board(day * 7)
        }
    }

    /// A fresh board. `avoid` are questions already served; `quick` asks for a
    /// short Fast Money question.
    func survey(avoid: [String] = [], quick: Bool = false) async -> Survey {
        guard let req = post("/api/survey", ["avoid": Array(avoid.suffix(15)), "quick": quick]) else {
            return QuestionBank.random
        }
        do {
            return try await fetch(Survey.self, req)
        } catch {
            return QuestionBank.random
        }
    }

    /// Ask the AI referee whether a guess the fuzzy matcher missed still means
    /// one of the answers. Returns nil for "no, that's a strike".
    func judge(q: String, answers: [Answer], guess: String) async -> Int? {
        struct Verdict: Codable { let index: Int }
        guard let req = post("/api/judge", [
            "q": String(q.prefix(200)),
            "answers": answers.prefix(8).map { String($0.text.prefix(40)) },
            "guess": String(guess.prefix(60)),
        ]) else { return nil }
        do {
            let v = try await fetch(Verdict.self, req)
            return v.index >= 0 ? v.index : nil
        } catch {
            return nil
        }
    }

    // ── Voices ──

    func ttsStatus() async -> TTSStatus {
        guard let u = url("/api/tts/status") else { return TTSStatus(failed: "no server configured") }
        do {
            return try await fetch(TTSStatus.self, URLRequest(url: u))
        } catch {
            return TTSStatus(failed: "server unreachable")
        }
    }

    /// Raw WAV for one line, or nil if the server can't produce it.
    func ttsClip(text: String, voice: String) async -> Data? {
        var parts = URLComponents()
        parts.queryItems = [
            .init(name: "text", value: String(text.prefix(160))),
            .init(name: "voice", value: voice),
        ]
        guard let query = parts.percentEncodedQuery, let u = url("/api/tts?\(query)") else { return nil }
        do {
            let (data, res) = try await session.data(for: URLRequest(url: u))
            guard let http = res as? HTTPURLResponse, http.statusCode == 200, !data.isEmpty else { return nil }
            return data
        } catch {
            return nil
        }
    }

    /// Have the server synthesise lines before the show needs them.
    func warm(_ items: [(text: String, voice: String)]) async {
        let payload = items.prefix(60).map { ["text": String($0.text.prefix(160)), "voice": $0.voice] }
        guard !payload.isEmpty, let req = post("/api/tts/warm", ["items": payload]) else { return }
        _ = try? await session.data(for: req)
    }
}
