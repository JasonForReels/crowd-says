import Foundation

/// One answer on the board: display text, its share of the 100-person survey,
/// and spellings the matcher should also accept.
struct Answer: Codable, Hashable {
    let text: String
    let points: Int
    var aliases: [String] = []

    enum CodingKeys: String, CodingKey { case text, points, aliases }

    init(text: String, points: Int, aliases: [String] = []) {
        self.text = text
        self.points = points
        self.aliases = aliases
    }

    init(from decoder: Decoder) throws {
        // The server sends answers as ["Check phone", 32, ["phone", ...]];
        // the bundled bank is written as objects. Accept either.
        if var arr = try? decoder.unkeyedContainer() {
            text = try arr.decode(String.self)
            points = try arr.decode(Int.self)
            aliases = (try? arr.decode([String].self)) ?? []
            return
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.decode(String.self, forKey: .text)
        points = try c.decode(Int.self, forKey: .points)
        aliases = (try? c.decode([String].self, forKey: .aliases)) ?? []
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(text, forKey: .text)
        try c.encode(points, forKey: .points)
        try c.encode(aliases, forKey: .aliases)
    }
}

/// One board: the question, its answers highest-first, and — when the server
/// wrote it — plausible-but-wrong answers the rival family can blurt out.
struct Survey: Codable, Hashable, Identifiable {
    let q: String
    let a: [Answer]
    var wrong: [String] = []
    /// True when this board came from the bundled bank because generation failed.
    var fallback = false

    var id: String { q }
    var maxScore: Int { a.reduce(0) { $0 + $1.points } }

    enum CodingKeys: String, CodingKey { case q, a, wrong, fallback }

    init(q: String, a: [Answer], wrong: [String] = [], fallback: Bool = false) {
        self.q = q
        self.a = a
        self.wrong = wrong
        self.fallback = fallback
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        q = try c.decode(String.self, forKey: .q)
        a = try c.decode([Answer].self, forKey: .a)
        wrong = (try? c.decode([String].self, forKey: .wrong)) ?? []
        fallback = (try? c.decode(Bool.self, forKey: .fallback)) ?? false
    }
}

/// The hand-written bank shipped in the app, used offline and whenever the
/// survey writer can't be reached.
enum QuestionBank {
    static let all: [Survey] = {
        guard let url = Bundle.main.url(forResource: "questions", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let qs = try? JSONDecoder().decode([Survey].self, from: data)
        else {
            assertionFailure("questions.json missing from the app bundle")
            return []
        }
        return qs
    }()

    /// Wraps around in both directions, so any Int is a valid board.
    static func board(_ n: Int) -> Survey {
        guard !all.isEmpty else { return Survey(q: "No boards available.", a: [], fallback: true) }
        var s = all[((n % all.count) + all.count) % all.count]
        s.fallback = true
        return s
    }

    static var random: Survey { board(Int.random(in: 0..<max(1, all.count))) }
}
