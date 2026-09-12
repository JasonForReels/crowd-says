import SwiftUI

/// One board, three strikes. Drives the daily and practice screens.
@MainActor
final class GameModel: ObservableObject {
    let survey: Survey
    let maxStrikes = 3

    @Published var shown: Set<Int> = []
    @Published var strikes = 0
    @Published var log: [DailyProgress.LogEntry] = []
    /// Answers nobody got, as the audience calls them out one at a time.
    @Published var called: [Int] = []
    @Published var judging = false
    @Published var toast: ToastMessage?
    @Published var flash = 0

    /// Set when the board was already finished before it was reopened, so the
    /// misses are all shown at once instead of being read out again.
    private let openedFinished: Bool
    private var finishTask: Task<Void, Never>?
    private var didFinish = false
    /// Called after every guess with the state worth persisting.
    private let onChange: ((Set<Int>, Int, [DailyProgress.LogEntry]) -> Void)?
    private let onFinish: ((Int) -> Void)?

    var allFound: Bool { shown.count == survey.a.count }
    var isOver: Bool { allFound || strikes >= maxStrikes }
    var score: Int { shown.reduce(0) { $0 + survey.a[$1].points } }
    var pct: Int { survey.maxScore > 0 ? Int((Double(score) / Double(survey.maxScore) * 100).rounded()) : 0 }

    var missed: Set<Int> {
        guard isOver else { return [] }
        if openedFinished { return Set(survey.a.indices.filter { !shown.contains($0) }) }
        return Set(called)
    }

    init(
        survey: Survey,
        progress: DailyProgress? = nil,
        onChange: ((Set<Int>, Int, [DailyProgress.LogEntry]) -> Void)? = nil,
        onFinish: ((Int) -> Void)? = nil
    ) {
        self.survey = survey
        self.onChange = onChange
        self.onFinish = onFinish
        shown = Set(progress?.shown ?? [])
        strikes = progress?.strikes ?? 0
        log = progress?.log ?? []
        openedFinished = (progress?.isOver ?? false)
    }

    /// The host reads a fresh board's question, and the audience's lines are
    /// synthesised before the board can end.
    func begin(readQuestion: Bool) {
        Voice.shared.warm(
            [(VoiceRole.crowd, "Good answer!")] + survey.a.map { (VoiceRole.crowd, $0.text) }
        )
        guard readQuestion, !isOver else { return }
        Task { await Voice.shared.host(survey.q) }
    }

    func guess(_ text: String) async {
        guard !isOver, !judging else { return }
        if log.contains(where: { $0.text.lowercased() == text.lowercased() }) {
            return say("You already tried that one")
        }

        if let i = findAnswer(text, in: survey.a) {
            return reveal(i, guess: text)
        }

        // The fuzzy matcher missed. Let the AI referee catch synonyms before
        // we buzz — but only when a server is there to ask.
        judging = true
        let verdict = await API.shared.judge(q: survey.q, answers: survey.a, guess: text)
        judging = false
        if let i = verdict, !shown.contains(i) {
            return reveal(i, guess: text)
        }

        SFX.buzz()
        SFX.groan()
        strikes += 1
        record(.init(text: text, index: -1))
        flash = Int(Date().timeIntervalSince1970 * 1000)
        checkFinished()
    }

    private func reveal(_ i: Int, guess text: String) {
        guard !shown.contains(i) else {
            return say("\"\(survey.a[i].text)\" is already up there")
        }
        SFX.flip()
        Task {
            try? await Task.sleep(nanoseconds: 420_000_000)
            SFX.ding()
        }
        shown.insert(i)
        record(.init(text: text, index: i))
        say("Survey says… \(survey.a[i].points)!", kind: .good)
        if shown.count < survey.a.count {
            Task { await Voice.shared.crowd("Good answer!") }
        }
        checkFinished()
    }

    private func record(_ entry: DailyProgress.LogEntry) {
        log.append(entry)
        onChange?(shown, strikes, log)
    }

    func say(_ text: String, kind: ToastMessage.Kind = .info) {
        toast = ToastMessage(text: text, kind: kind)
        Task {
            try? await Task.sleep(nanoseconds: 2_200_000_000)
            if toast?.text == text { toast = nil }
        }
    }

    /// Cleared the board: applause. Out of strikes: the audience reads out
    /// everything that was left.
    private func checkFinished() {
        guard isOver, !didFinish else { return }
        didFinish = true
        onFinish?(score)

        if allFound {
            SFX.win()
            SFX.applause(3, 0.6)
            return
        }

        finishTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            guard let self, !Task.isCancelled else { return }
            for i in survey.a.indices where !shown.contains(i) {
                if Task.isCancelled { return }
                SFX.flip()
                called.append(i)
                try? await Task.sleep(nanoseconds: 380_000_000)
                await Voice.shared.crowd(survey.a[i].text)
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
        }
    }

    func stop() {
        finishTask?.cancel()
        Voice.shared.stop()
    }
}

/// The board, the strikes, the guess field, and — once it's over — the result.
struct GameView<Result: View>: View {
    @ObservedObject var model: GameModel
    var readQuestion = true
    @ViewBuilder var result: (GameModel) -> Result

    var body: some View {
        VStack(spacing: 18) {
            QuestionText(text: model.survey.q)

            BoardView(answers: model.survey.a, shown: model.shown, missed: model.missed)

            HStack {
                StrikesView(n: model.strikes)
                Spacer()
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text("\(model.score)").font(.display(24)).foregroundStyle(Color.gold)
                    Text("pts").font(.system(size: 12, weight: .bold)).foregroundStyle(Color.ink2)
                }
            }

            if !model.isOver {
                GuessBox(
                    placeholder: model.judging ? "Checking with the crowd…" : "Type a guess…",
                    disabled: model.judging
                ) { text in
                    Task { await model.guess(text) }
                }
                if model.survey.fallback {
                    Text("Couldn't reach the survey writer, so this is a classic board.")
                        .font(.system(size: 12))
                        .foregroundStyle(Color.ink2)
                        .multilineTextAlignment(.center)
                }
            } else {
                VStack(spacing: 12) {
                    Text(rankFor(pct: model.pct))
                        .font(.display(24))
                        .foregroundStyle(Color.gold)
                        .multilineTextAlignment(.center)
                    Text("You found \(model.shown.count) of \(model.survey.a.count) answers for \(model.score) of \(model.survey.maxScore) points.")
                        .font(.system(size: 15))
                        .foregroundStyle(Color.ink)
                        .multilineTextAlignment(.center)
                    result(model)
                }
                .padding(.vertical, 6)
            }

            if !model.log.isEmpty {
                // Every guess so far, hits and misses.
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(model.log.enumerated()), id: \.offset) { _, entry in
                        Text("\(entry.index >= 0 ? "✓" : "✕") \(entry.text)")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(entry.index >= 0 ? Color.gold : Color.ink2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .onAppear { model.begin(readQuestion: readQuestion) }
        .onDisappear { model.stop() }
    }
}
