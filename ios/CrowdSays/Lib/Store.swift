import Foundation

/// Board numbering: the same epoch the web game uses, in local time, so a
/// phone and a browser in the same timezone agree on which board is today's.
private let epoch = DateComponents(year: 2026, month: 1, day: 1)

func dayNumber(_ date: Date = Date()) -> Int {
    let cal = Calendar.current
    guard let start = cal.date(from: epoch) else { return 1 }
    let from = cal.startOfDay(for: start)
    let to = cal.startOfDay(for: date)
    return (cal.dateComponents([.day], from: from, to: to).day ?? 0) + 1
}

/// Seconds until the next board, for the countdown.
func secondsUntilTomorrow(_ now: Date = Date()) -> Int {
    let cal = Calendar.current
    guard let next = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: now)) else { return 0 }
    return max(0, Int(next.timeIntervalSince(now)))
}

func rankFor(pct: Int) -> String {
    if pct >= 100 { return "Crowd Whisperer 👑" }
    if pct >= 75 { return "Survey Savant 🧠" }
    if pct >= 50 { return "Pretty Popular 😎" }
    if pct > 0 { return "Hot Take Haver 🌶️" }
    return "Certified Contrarian 🙃"
}

/// A day's progress on the daily board, resumable across launches.
struct DailyProgress: Codable {
    var survey: Survey
    var shown: [Int] = []
    var strikes: Int = 0
    /// Every guess, with the answer index it hit, or -1 for a strike.
    var log: [LogEntry] = []

    struct LogEntry: Codable, Hashable {
        var text: String
        var index: Int
    }

    var isOver: Bool { strikes >= 3 || shown.count >= survey.a.count }
    var isStarted: Bool { strikes > 0 || !shown.isEmpty }
    var score: Int { shown.reduce(0) { $0 + (survey.a.indices.contains($1) ? survey.a[$1].points : 0) } }
}

struct Stats: Codable {
    var played = 0
    var streak = 0
    var best = 0
    var last = 0

    /// The streak only counts if yesterday's board was the last one played.
    func currentStreak(today: Int) -> Int { last >= today - 1 ? streak : 0 }
}

/// Everything the app persists, in UserDefaults — mirrors the web game's
/// localStorage keys so the two stay conceptually in step.
enum Store {
    private static let d = UserDefaults.standard

    private static func get<T: Decodable>(_ key: String, _ fallback: T) -> T {
        guard let data = d.data(forKey: key), let v = try? JSONDecoder().decode(T.self, from: data) else {
            return fallback
        }
        return v
    }

    private static func set<T: Encodable>(_ key: String, _ value: T) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        d.set(data, forKey: key)
    }

    // ── Daily ──
    static func daily(_ day: Int) -> DailyProgress? {
        guard let data = d.data(forKey: "cs-daily-\(day)") else { return nil }
        return try? JSONDecoder().decode(DailyProgress.self, from: data)
    }
    static func saveDaily(_ day: Int, _ p: DailyProgress) { set("cs-daily-\(day)", p) }

    // ── Stats ──
    static var stats: Stats {
        get { get("cs-stats", Stats()) }
        set { set("cs-stats", newValue) }
    }

    /// Records a finished daily once per day, and returns the updated stats.
    @discardableResult
    static func recordDaily(day: Int, score: Int) -> Stats {
        var st = stats
        guard st.last != day else { return st }
        st.streak = st.last == day - 1 ? st.streak + 1 : 1
        st.played += 1
        st.best = max(st.best, score)
        st.last = day
        stats = st
        return st
    }

    // ── Questions already served, so practice doesn't repeat itself ──
    static var seen: [String] {
        get { get("cs-seen", [String]()) }
        set { set("cs-seen", Array(newValue.suffix(30))) }
    }

    // ── Misc preferences ──
    static var familyName: String {
        get { d.string(forKey: "cs-family") ?? "The Smiths" }
        set { d.set(newValue, forKey: "cs-family") }
    }

    /// Where the survey writer and voice server live. Empty means offline: the
    /// bundled question bank and the iPhone's own voice.
    ///
    /// A stored *empty* string falls back to the bundled default rather than
    /// shadowing it — otherwise clearing the field once would permanently
    /// override the build's server and leave the app offline with no way back.
    static var serverURL: String {
        get {
            if let v = d.string(forKey: "cs-server"), !v.trimmingCharacters(in: .whitespaces).isEmpty {
                return v
            }
            return bundledServerURL
        }
        set {
            let clean = newValue.trimmingCharacters(in: .whitespaces)
            if clean.isEmpty {
                d.removeObject(forKey: "cs-server") // back to the bundled default
            } else {
                d.set(clean, forKey: "cs-server")
            }
        }
    }

    /// The server this build ships with, from Info.plist.
    static var bundledServerURL: String {
        (Bundle.main.object(forInfoDictionaryKey: "CSServerURL") as? String ?? "")
            .trimmingCharacters(in: .whitespaces)
    }

    static var isMuted: Bool {
        get { d.bool(forKey: "cs-muted") }
        set { d.set(newValue, forKey: "cs-muted") }
    }

    static var voiceEngine: String {
        get { d.string(forKey: "cs-voice") ?? VoiceEngine.system.rawValue }
        set { d.set(newValue, forKey: "cs-voice") }
    }

    /// The curtain overture only plays once per launch, not on every trip home.
    static var sawCurtain = false
}
