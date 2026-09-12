import SwiftUI

/*
  Fast Money, solo: you play both halves. Five questions in 20 seconds, then
  the same five again in 25 seconds with your first answers covered — and a
  repeated answer gets the double-buzz. 200 points across the two halves wins.
*/

private let goal = 200
private let times = [20.0, 25.0]

/// One answer given in Fast Money, refereed in the background.
private struct FMAnswer {
    var text: String
    var index: Int?
    var points = 0
    /// The referee's verdict, still arriving while the clock runs.
    var pending: Task<Int?, Never>?
}

/// Whether a cell's text and points have been turned over yet.
private struct FMCell {
    var text = false
    var points = false
}

@MainActor
final class FastMoneyModel: ObservableObject {
    enum Stage { case loading, intro, play, reveal, between, done }

    @Published var stage: Stage = .loading
    @Published var pass = 0
    @Published var line = ""
    @Published var total = 0
    @Published var won = false
    @Published var toast: ToastMessage?
    @Published var deadline: Date?
    /// The row being read out during the reveal.
    @Published var active: Int?

    @Published fileprivate var questions: [Survey] = []
    @Published fileprivate var answers: [[FMAnswer?]] = [[], []]
    @Published fileprivate var cells: [[FMCell]] = [[], []]
    /// Question indices still to be answered this pass, in order.
    @Published fileprivate var queue: [Int] = []

    private var finish: CheckedContinuation<String, Never>?
    private var director: Task<Void, Never>?
    private var ticker: Task<Void, Never>?
    let name: String

    init(name: String) { self.name = name }

    var current: Survey? {
        guard let k = queue.first, questions.indices.contains(k) else { return nil }
        return questions[k]
    }

    var currentNumber: Int { (queue.first ?? 0) + 1 }

    func load(_ boards: Task<[Survey], Never>?) async {
        // The main game normally fetches these during round one; if that
        // didn't happen, write them now.
        let qs: [Survey]
        if let prefetched = boards {
            qs = await prefetched.value
        } else {
            var out: [Survey] = []
            for _ in 0..<5 { out.append(await API.shared.survey(quick: true)) }
            qs = out
        }
        questions = qs
        stage = .intro
        Voice.shared.warm([
            (.host, "Welcome to Fast Money! Five questions, \(Int(times[0])) seconds. You need \(goal) points."),
            (.host, "Let's see how you did."),
            (.crowd, "You did it!"),
            (.crowd, "Awww!"),
        ])
    }

    private func say(_ text: String) async throws {
        line = text
        await Voice.shared.host(text)
        try Task.checkCancellation()
    }

    private func wait(_ s: Double) async throws {
        try await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000))
        try Task.checkCancellation()
    }

    /// One half: the clock runs, then every answer is turned over in turn.
    private func playPass(_ p: Int) async throws {
        answers[p] = questions.map { _ in nil }
        cells[p] = questions.map { _ in FMCell() }
        queue = Array(questions.indices)
        pass = p
        line = ""
        stage = .play
        let end = Date().addingTimeInterval(times[p])
        deadline = end

        // The last five seconds tick.
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard let self, let d = self.deadline else { return }
                let left = d.timeIntervalSinceNow
                if left > 0 && left < 5.5 { SFX.tick() }
            }
        }

        // Whichever comes first: the clock, or the fifth answer.
        let timeout = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(times[p] * 1_000_000_000))
            self?.finishPass("time")
        }
        let how = await withCheckedContinuation { (c: CheckedContinuation<String, Never>) in
            finish = c
        }
        timeout.cancel()
        ticker?.cancel()
        try Task.checkCancellation()

        if how == "time" { SFX.timeUp() }
        stage = .reveal
        deadline = nil
        try await wait(0.7)
        try await say(p == 0 ? "Let's see how you did." : "Here comes the second half!")

        for k in questions.indices {
            active = k
            cells[p][k].text = true
            guard var a = answers[p][k] else {
                try await wait(0.5)
                cells[p][k].points = true
                continue
            }
            try await say("\(a.text). Survey says…")
            // The referee has had the whole clock to decide; collect it now.
            if a.index == nil, let pending = a.pending {
                a.index = await pending.value
            }
            a.points = a.index.map { questions[k].a[$0].points } ?? 0
            answers[p][k] = a
            cells[p][k].points = true
            total += a.points
            if a.points > 0 { SFX.ding() } else { SFX.buzz() }
            try await wait(0.9)
            if total >= goal { break }
        }
        active = nil
    }

    private func finishPass(_ how: String) {
        guard let c = finish else { return }
        finish = nil
        c.resume(returning: how)
    }

    func start() {
        run {
            SFX.applause(2, 0.5)
            try await self.say("Welcome to Fast Money! Five questions, \(Int(times[0])) seconds. You need \(goal) points.")
            try await self.playPass(0)
            if self.total >= goal { return try await self.end() }
            self.stage = .between
            try await self.say(
                "\(self.total) points. You need \(goal - self.total) more. Second half: \(Int(times[1])) seconds, your answers are covered, and no repeats!"
            )
        }
    }

    func startSecondHalf() {
        run {
            try await self.playPass(1)
            try await self.end()
        }
    }

    private func end() async throws {
        won = total >= goal
        stage = .done
        if won {
            SFX.win()
            SFX.applause(4.5, 0.8)
            Task { await Voice.shared.crowd("You did it!") }
            try await say("Congratulations, \(name)! \(total) points. You win Fast Money!")
        } else {
            SFX.groan()
            Task { await Voice.shared.crowd("Awww!") }
            try await say("So close! \(total) points. Thanks for playing!")
        }
    }

    /// Locks in an answer for the question on top of the queue.
    func submit(_ text: String) {
        guard stage == .play, let k = queue.first else { return }
        let q = questions[k]
        let i = findAnswer(text, in: q.a)

        if pass == 1, let prev = answers[0][k] {
            // No repeats in the second half.
            let same = normalizeForDupe(prev.text) == normalizeForDupe(text)
            if same || (i != nil && i == prev.index) {
                SFX.dupe()
                toast = ToastMessage(text: "Duplicate answer — try again!", kind: .bad)
                return
            }
        }

        // Referee in the background so the clock isn't waiting on it.
        let pending: Task<Int?, Never>? = i == nil
            ? Task { await API.shared.judge(q: q.q, answers: q.a, guess: text) }
            : nil
        answers[pass][k] = FMAnswer(text: text, index: i, pending: pending)
        Voice.shared.warm([(.host, "\(text). Survey says…")])
        queue.removeFirst()
        if queue.isEmpty { finishPass("done") }
    }

    /// Sends the current question to the back of the queue.
    func passQuestion() {
        guard queue.count > 1 else { return }
        queue.append(queue.removeFirst())
    }

    private func normalizeForDupe(_ t: String) -> String {
        t.lowercased().filter { $0.isLetter || $0.isNumber }
    }

    private func run(_ body: @escaping () async throws -> Void) {
        director?.cancel()
        director = Task {
            do { try await body() }
            catch is CancellationError { }
            catch { print("[crowd-says] \(error)") }
        }
    }

    func stop() {
        director?.cancel()
        ticker?.cancel()
        finishPass("done")
        Voice.shared.stop()
    }
}

struct FastMoneyView: View {
    let boards: Task<[Survey], Never>?
    let name: String
    let onHome: () -> Void

    @StateObject private var m: FastMoneyModel

    init(boards: Task<[Survey], Never>?, name: String, onHome: @escaping () -> Void) {
        self.boards = boards
        self.name = name
        self.onHome = onHome
        _m = StateObject(wrappedValue: FastMoneyModel(name: name))
    }

    var body: some View {
        ZStack {
            ScrollView {
                VStack(spacing: 18) {
                    ShowBar(title: "Fast Money", backLabel: "Leave", onBack: onHome)
                    HostLine(text: m.line)

                    switch m.stage {
                    case .loading:
                        LoadingView(label: "Writing five fast questions…")

                    case .intro:
                        VStack(spacing: 12) {
                            Text("\(goal) points to win")
                                .font(.display(26))
                                .foregroundStyle(Color.gold)
                            Text("Five questions, \(Int(times[0])) seconds. Answer fast; hit Pass to come back to one. Then you play the same five again in \(Int(times[1])) seconds.")
                                .font(.system(size: 15))
                                .foregroundStyle(Color.ink)
                                .multilineTextAlignment(.center)
                            ShowButton(title: "Start the clock ⏱", gold: true, big: true) { m.start() }
                        }

                    default:
                        EmptyView()
                    }

                    if m.stage == .play, let q = m.current, let deadline = m.deadline {
                        VStack(spacing: 14) {
                            Clock(deadline: deadline)
                            QuestionText(text: q.q, kicker: "Question \(m.currentNumber) of 5")
                            FastMoneyInput(
                                key: "\(m.pass)-\(m.currentNumber)",
                                onSubmit: { m.submit($0) },
                                onPass: { m.passQuestion() }
                            )
                        }
                    }

                    if !m.questions.isEmpty, m.stage != .intro, m.stage != .loading {
                        FastMoneyBoard(m: m)
                    }

                    if m.stage == .between {
                        ShowButton(title: "Start the second half ⏱", gold: true, big: true) {
                            m.startSecondHalf()
                        }
                    }

                    if m.stage == .done {
                        VStack(spacing: 12) {
                            Text(m.won ? "You won Fast Money! 💰" : "So close!")
                                .font(.display(26))
                                .foregroundStyle(Color.gold)
                            Text("\(m.total) of \(goal) points.")
                                .font(.system(size: 15))
                                .foregroundStyle(Color.ink)
                            ShowButton(title: "Home", gold: true, action: onHome)
                        }
                    }
                }
                .padding(.horizontal, 18)
                .padding(.bottom, 90)
            }

            VStack {
                Spacer()
                ToastView(toast: m.toast).padding(.bottom, 100)
            }
        }
        .task { await m.load(boards) }
        .onDisappear { m.stop() }
    }
}

/// The two-column scoreboard: your first-half answers beside your second.
private struct FastMoneyBoard: View {
    @ObservedObject var m: FastMoneyModel

    var body: some View {
        VStack(spacing: 6) {
            ForEach(m.questions.indices, id: \.self) { k in
                HStack(spacing: 6) {
                    ForEach(0..<2, id: \.self) { p in
                        cell(k: k, p: p)
                    }
                }
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(m.active == k ? Color.gold.opacity(0.16) : Color.clear)
                )
            }
            HStack {
                Text("Total")
                    .font(.system(size: 13, weight: .black))
                    .tracking(1.1)
                    .textCase(.uppercase)
                    .foregroundStyle(Color.ink2)
                Spacer()
                Text("\(m.total)").font(.display(28)).foregroundStyle(Color.gold)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        }
    }

    @ViewBuilder
    private func cell(k: Int, p: Int) -> some View {
        // First-half answers stay covered while the second half is played.
        let covered = p == 0 && m.pass == 1 && m.stage == .play
        let a = m.answers[p].indices.contains(k) ? m.answers[p][k] : nil
        let c = m.cells[p].indices.contains(k) ? m.cells[p][k] : FMCell()

        HStack(spacing: 4) {
            Text(c.text && !covered ? (a?.text ?? "—") : "")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Spacer(minLength: 0)
            if c.points && !covered {
                CountUpText(to: a?.points ?? 0, run: true, delay: 0, duration: 0.5)
                    .font(.system(size: 14, weight: .black))
                    .foregroundStyle(Color.gold)
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 34)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 7)
                .fill(covered ? Color.showBlue.opacity(0.45) : Color.black.opacity(0.28))
        )
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(Color.white.opacity(0.14), lineWidth: 1))
    }
}

/// The answer field, with Pass. Remounted per question so it always starts empty.
private struct FastMoneyInput: View {
    let key: String
    let onSubmit: (String) -> Void
    let onPass: () -> Void

    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 8) {
            TextField("Answer fast…", text: $text)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Color.ink)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .submitLabel(.send)
                .focused($focused)
                .onSubmit(send)
                .padding(.horizontal, 14)
                .padding(.vertical, 13)
                .background(RoundedRectangle(cornerRadius: 12).fill(Color.black.opacity(0.3)))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.white.opacity(0.2), lineWidth: 1))
                .onChange(of: text) { _, new in
                    if new.count > 40 { text = String(new.prefix(40)) }
                }
            ShowButton(title: "Go", gold: true, enabled: !text.trimmed.isEmpty, action: send)
            ShowButton(title: "Pass", action: onPass)
        }
        .id(key)
        .onAppear { focused = true }
        .onChange(of: key) { _, _ in
            text = ""
            focused = true
        }
    }

    private func send() {
        let t = text.trimmed
        guard !t.isEmpty else { return }
        onSubmit(t)
        text = ""
    }
}

/// The big countdown clock.
private struct Clock: View {
    let deadline: Date

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.1)) { context in
            let left = max(0, Int(deadline.timeIntervalSince(context.date).rounded(.up)))
            Text("\(left)")
                .font(.display(54))
                .monospacedDigit()
                .foregroundStyle(left <= 5 ? Color.showRed : Color.gold)
                .scaleEffect(left <= 5 ? 1.1 : 1)
                .animation(.spring(response: 0.3), value: left)
        }
    }
}
