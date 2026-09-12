import SwiftUI

/// Today's board: one survey per day, the same for everyone, resumable.
struct DailyScreen: View {
    let onHome: () -> Void

    @State private var day = dayNumber()
    @State private var progress: DailyProgress?
    @State private var model: GameModel?

    var body: some View {
        ScreenShell(title: "Daily #\(day)", onBack: onHome) {
            if let model {
                GameView(model: model) { m in
                    DailyResult(
                        day: day,
                        survey: m.survey,
                        shown: m.shown,
                        strikes: m.strikes,
                        score: m.score,
                        pct: m.pct,
                        onHome: onHome
                    )
                }
            } else {
                LoadingView()
            }
        }
        .task {
            guard model == nil else { return }
            // Whatever was saved for today, otherwise ask for today's board.
            let existing = Store.daily(day)
            let survey: Survey
            if let existing {
                survey = existing.survey
            } else {
                survey = await API.shared.daily(day: day)
            }
            let start = existing ?? DailyProgress(survey: survey)
            Store.saveDaily(day, start)
            progress = start

            let d = day
            model = GameModel(survey: survey, progress: start) { shown, strikes, log in
                // Persist after every guess so the board survives being closed.
                Store.saveDaily(d, DailyProgress(
                    survey: survey,
                    shown: Array(shown),
                    strikes: strikes,
                    log: log
                ))
            }
        }
    }
}

/// Records the day's result once, then offers the spoiler-free share grid.
private struct DailyResult: View {
    let day: Int
    let survey: Survey
    let shown: Set<Int>
    let strikes: Int
    let score: Int
    let pct: Int
    let onHome: () -> Void

    @State private var stats = Stats()

    private var shareText: String {
        let grid = survey.a.indices.map { shown.contains($0) ? "🟧" : "⬛" }.joined()
        let marks = strikes > 0 ? String(repeating: "❌", count: strikes) : "no strikes"
        return """
        Crowd Says #\(day) 📋
        "\(survey.q)"
        \(grid)
        \(score) pts · \(marks)
        \(rankFor(pct: pct))
        """
    }

    var body: some View {
        VStack(spacing: 12) {
            HStack(spacing: 10) {
                ShareLink(item: shareText) {
                    Text("Share result")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(Color.navy)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 11)
                        .background(Capsule().fill(
                            LinearGradient(colors: [.gold, .gold2], startPoint: .top, endPoint: .bottom)
                        ))
                }
                ShowButton(title: "Home", action: onHome)
            }
            Text("🔥 \(stats.streak) day streak · \(stats.played) played · best \(stats.best)")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.ink2)
            CountdownText(prefix: "Next board in")
        }
        .onAppear { stats = Store.recordDaily(day: day, score: score) }
    }
}

/// Practice: endless fresh boards, with the next one fetched while you play.
struct PracticeScreen: View {
    let onHome: () -> Void

    @State private var model: GameModel?
    @State private var round = 0
    @State private var total = 0
    @State private var nextBoard: Task<Survey, Never>?

    var body: some View {
        ScreenShell(title: "Practice · board \(max(1, round))", onBack: onHome) {
            if let model {
                GameView(model: model) { _ in
                    VStack(spacing: 12) {
                        Text("Session total: \(total) pts over \(round) board\(round > 1 ? "s" : "")")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.ink2)
                        HStack(spacing: 10) {
                            ShowButton(title: "Next question ›", gold: true, big: true) {
                                Task { await advance() }
                            }
                            ShowButton(title: "Home", action: onHome)
                        }
                    }
                }
                .id(round)
            } else {
                LoadingView()
            }
        }
        .task {
            guard model == nil else { return }
            await advance()
        }
    }

    private func advance() async {
        model = nil
        let survey: Survey
        if let prefetched = nextBoard {
            survey = await prefetched.value
        } else {
            survey = await API.shared.survey(avoid: Store.seen)
        }
        nextBoard = nil
        Store.seen = Store.seen + [survey.q]
        round += 1
        model = GameModel(survey: survey, onFinish: { total += $0 })
        prefetch()
    }

    /// Writes and voices the next board while this one is being played.
    private func prefetch() {
        let avoid = Store.seen
        nextBoard = Task {
            let b = await API.shared.survey(avoid: avoid)
            await MainActor.run {
                Voice.shared.warm([(VoiceRole.host, b.q)] + b.a.map { (VoiceRole.crowd, $0.text) })
            }
            return b
        }
    }
}

// ── Shared bits ──

/// The standard screen: title bar, scrolling body, stage background.
struct ScreenShell<Content: View>: View {
    let title: String
    var backLabel = "Home"
    let onBack: () -> Void
    @ViewBuilder var content: () -> Content

    var body: some View {
        ZStack {
            StageBackground()
            ScrollView {
                VStack(spacing: 18) {
                    ShowBar(title: title, backLabel: backLabel, onBack: onBack)
                    content()
                }
                .padding(.horizontal, 18)
                .padding(.bottom, 90)
            }
        }
    }
}

/// The clock until the next daily board.
struct CountdownText: View {
    var prefix = ""
    @State private var left = secondsUntilTomorrow()

    var body: some View {
        Text("\(prefix) \(formatted)".trimmed)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(Color.ink2)
            .monospacedDigit()
            .task {
                while !Task.isCancelled {
                    left = secondsUntilTomorrow()
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                }
            }
    }

    private var formatted: String {
        let p = { (n: Int) in String(format: "%02d", n) }
        return "\(p(left / 3600)):\(p((left % 3600) / 60)):\(p(left % 60))"
    }
}
