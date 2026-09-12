import Foundation

/*
  A full episode, solo: you against a computer family.

  Each round: the host reads the question, face-off at the buzzers (the top
  answer wins outright, otherwise the higher answer does), the winner chooses
  play or pass, three strikes hands the other family one guess to steal the
  bank, and the audience calls out whatever's left. Points double in round 3
  and triple after that. First to 300 wins; if that's you, it's on to Fast
  Money.

  The episode is one long async "director" per round. Cancelling the task —
  which happens when you leave the screen — unwinds it at the next await.
*/

let showTarget = 300
private let maxRounds = 6
private let mults = [1, 1, 2, 3, 3, 3]
private let rivals = [
    "The Hendersons", "The Garcias", "The Nguyens", "The Okafors",
    "The Kowalskis", "The Pattersons", "The Castellanos", "The Lindqvists",
]
private let filler = ["Pizza", "Socks", "Grandma", "A Hat", "Money", "Duct Tape", "Bananas", "My Uncle"]

enum ShowStage {
    case intro, loading, round, faceoff, choose, play, cpu, steal, roundEnd, gameOver, fastMoney
}

enum InputMode: String {
    case buzz, answer, play, steal

    var label: String {
        switch self {
        case .buzz: return "Buzz!"
        case .answer: return "Answer"
        case .play: return "Guess"
        case .steal: return "Steal!"
        }
    }
}

@MainActor
final class ShowModel: ObservableObject {
    @Published var stage: ShowStage = .intro
    @Published var names: [String]
    @Published var scores = [0, 0]
    @Published var round = 0
    @Published var board: Survey?
    @Published var qShown = false
    @Published var shown: Set<Int> = []
    @Published var missed: Set<Int> = []
    @Published var strikes = 0
    /// How many X's the strike flash shows — a non-counting strike still shows one.
    @Published var xs = 1
    @Published var bank = 0
    @Published var mult = 1
    /// Which family is playing the board, 0 = you.
    @Published var control: Int?
    @Published var line = ""
    /// The rival family's speech bubble.
    @Published var bubble: String?
    @Published var input: InputMode?
    @Published var deadline: Date?
    @Published var checking = false
    @Published var flash = 0
    @Published var toast: ToastMessage?
    @Published var hot: Int?
    @Published var winner: Int?

    private var usedWrong: Set<String> = []
    private var seen: [String] = []
    private var next: Task<Survey, Never>?
    /// The five Fast Money boards, fetched during the main game.
    private(set) var fmBoards: Task<[Survey], Never>?

    private var pendingGuess: CheckedContinuation<String?, Never>?
    private var pendingChoice: CheckedContinuation<String, Never>?
    private var director: Task<Void, Never>?

    init() {
        names = [Store.familyName, rivals.randomElement() ?? "The Hendersons"]
    }

    // ── Primitives the director is built from ──

    private func wait(_ seconds: Double) async throws {
        try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        try Task.checkCancellation()
    }

    private func say(_ text: String) async throws {
        line = text
        await Voice.shared.host(text)
        try Task.checkCancellation()
    }

    private func rivalSay(_ text: String) async throws {
        bubble = text
        await Voice.shared.rival(text)
        try Task.checkCancellation()
    }

    private func cheer(_ text: String) async throws {
        await Voice.shared.crowd(text)
        try Task.checkCancellation()
    }

    private func show(_ text: String, kind: ToastMessage.Kind = .info) {
        toast = ToastMessage(text: text, kind: kind)
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_200_000_000)
            if self?.toast?.text == text { self?.toast = nil }
        }
    }

    /// Opens the guess field and waits. Returns nil on a timeout, or when the
    /// rival family buzzes in first.
    private func askGuess(_ mode: InputMode, timeout: Double? = nil) async -> String? {
        // Never strand an earlier waiter, or its continuation leaks.
        cancelGuess()
        input = mode
        deadline = timeout.map { Date().addingTimeInterval($0) }
        if let timeout {
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                self?.cancelGuess()
            }
        }
        return await withCheckedContinuation { cont in
            pendingGuess = cont
        }
    }

    /// Resolves a waiting askGuess with nothing, so the director moves on.
    func cancelGuess() {
        guard let cont = pendingGuess else { return }
        pendingGuess = nil
        input = nil
        deadline = nil
        cont.resume(returning: nil)
    }

    func submitGuess(_ text: String) {
        guard let cont = pendingGuess else { return }
        pendingGuess = nil
        input = nil
        deadline = nil
        cont.resume(returning: text)
    }

    func choose(_ choice: String) {
        guard let cont = pendingChoice else { return }
        pendingChoice = nil
        cont.resume(returning: choice)
    }

    /// The fuzzy matcher first, then the AI referee for anything it missed.
    private func evaluate(_ text: String) async -> Int? {
        guard let b = board else { return nil }
        if let i = findAnswer(text, in: b.a) { return i }
        checking = true
        let i = await API.shared.judge(q: b.q, answers: b.a, guess: text)
        checking = false
        return i
    }

    private func reveal(_ i: Int) async throws {
        guard let b = board else { return }
        SFX.flip()
        shown.insert(i)
        bank += b.a[i].points
        hot = i
        try await wait(0.42)
        SFX.ding()
        try await wait(0.3)
    }

    /// `counts` is false for face-off and steal misses, which buzz without
    /// adding to the three strikes.
    private func strike(counts: Bool) async throws {
        SFX.buzz()
        if counts { strikes += 1 }
        xs = counts ? strikes : 1
        flash = Int(Date().timeIntervalSince1970 * 1000)
        SFX.groan()
        try await wait(1.15)
    }

    /// The rival family's guess: a real answer with probability `pHit`,
    /// otherwise one of the board's decoys.
    private func cpuPick(pHit: Double) -> (index: Int?, text: String) {
        guard let b = board else { return (nil, "Uhh… pass") }
        let open = b.a.indices.filter { !shown.contains($0) }
        if !open.isEmpty, Double.random(in: 0..<1) < pHit {
            // Weighted towards the higher-scoring answers still up there.
            let weights = open.map { Double(b.a[$0].points + 4) }
            let total = weights.reduce(0, +)
            var r = Double.random(in: 0..<total)
            for (k, i) in open.enumerated() {
                r -= weights[k]
                if r <= 0 { return (i, b.a[i].text) }
            }
            return (open.last, b.a[open.last!].text)
        }

        var pool = b.wrong.filter { !usedWrong.contains($0) }
        if pool.isEmpty { pool = filler.filter { !usedWrong.contains($0) } }
        let text = pool.randomElement() ?? "Uhh… pass"
        usedWrong.insert(text)
        // A decoy that happens to match a board answer still counts.
        if let i = findAnswer(text, in: b.a), !shown.contains(i) { return (i, text) }
        return (nil, text)
    }

    private func award(to team: Int) async throws {
        let pts = bank * mult
        scores[team] += pts
        bubble = nil
        winner = team
        SFX.win()
        SFX.applause(2.6, team == 0 ? 0.6 : 0.35)
        try await say("\(names[team]) take the bank. \(pts) points!")
    }

    // ── The round, start to finish ──

    /// Returns the family that won the buzzers.
    private func faceoff() async throws -> Int {
        guard let b = board else { return 0 }
        let n = b.a.count

        for attempt in 0..<3 {
            if shown.count >= n { break }
            stage = .faceoff
            bubble = nil
            try await say(attempt > 0 ? "Back to the buzzers!" : "Hands on your buzzers!")

            // Race you against the rival's reflexes: whoever lands first.
            let cpuAt = Double.random(in: 2.2...6.5)
            let timer = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(cpuAt * 1_000_000_000))
                guard !Task.isCancelled else { return }
                await MainActor.run { self?.cancelGuess() }
            }
            let typed = await askGuess(.buzz)
            timer.cancel()
            try Task.checkCancellation()
            let youBuzzedFirst = typed != nil
            SFX.buzzer()

            var you = -1
            var cpu = -1

            if youBuzzedFirst {
                line = "\(names[0]) buzzed in first!"
                you = try await takeYourTurn(typed) ?? -1
                if you == 0 { return 0 } // the top answer wins the face-off outright
                cpu = try await takeRivalTurn() ?? -1
            } else {
                try await say("\(names[1]) buzzed in first!")
                cpu = try await takeRivalTurn() ?? -1
                if cpu == 0 { return 1 }
                try await say("\(names[0]), can you beat that?")
                you = try await takeYourTurn(await askGuess(.answer, timeout: 12)) ?? -1
            }

            if you < 0 && cpu < 0 { continue } // nobody scored; back to the buzzers
            let yp = you >= 0 ? b.a[you].points : -1
            let cp = cpu >= 0 ? b.a[cpu].points : -1
            if yp == cp { return youBuzzedFirst ? 0 : 1 }
            return yp > cp ? 0 : 1
        }
        return 0
    }

    private func takeYourTurn(_ text: String?) async throws -> Int? {
        guard let text else {
            show("Time!", kind: .bad)
            try await strike(counts: false)
            return nil
        }
        // Evaluate while the host is still talking, as on the web.
        async let verdict = evaluate(text)
        try await say("Survey says!")
        let i = await verdict
        if let i, !shown.contains(i) {
            try await reveal(i)
            return i
        }
        try await strike(counts: false)
        return nil
    }

    private func takeRivalTurn() async throws -> Int? {
        bubble = "…"
        try await wait(0.6)
        let pick = cpuPick(pHit: 0.62)
        try await rivalSay(pick.text)
        try await say("Survey says!")
        if let i = pick.index {
            try await reveal(i)
            return i
        }
        try await strike(counts: false)
        return nil
    }

    /// You have the board: guess until you clear it or strike out.
    private func youPlay() async throws {
        guard let b = board else { return }
        let n = b.a.count
        stage = .play
        control = 0
        bubble = nil
        try await say("\(names[0]), you're playing. Three strikes and they can steal!")

        while strikes < 3 && shown.count < n {
            try Task.checkCancellation()
            stage = .play
            guard let text = await askGuess(.play) else { continue }
            if let already = findAnswer(text, in: b.a), shown.contains(already) {
                show("\"\(b.a[already].text)\" is already up there")
                continue
            }
            async let verdict = evaluate(text)
            try await say("Survey says!")
            let i = await verdict
            if let i, !shown.contains(i) {
                try await reveal(i)
                if shown.count < n { try await cheer("Good answer!") }
            } else {
                try await strike(counts: true)
            }
        }

        if shown.count == n { return try await award(to: 0) }

        stage = .steal
        try await say("\(names[1]), you have one chance to steal!")
        bubble = "Huddling up…"
        try await wait(2.6)
        let pick = cpuPick(pHit: 0.4)
        try await rivalSay(pick.text)
        try await say("Survey says!")
        if let i = pick.index {
            try await reveal(i)
            return try await award(to: 1)
        }
        try await strike(counts: false)
        try await award(to: 0)
    }

    /// The rival family has the board; you get the steal if they strike out.
    private func cpuPlay() async throws {
        guard let b = board else { return }
        let n = b.a.count
        stage = .cpu
        control = 1
        try await say("\(names[1]) are playing.")

        while strikes < 3 && shown.count < n {
            bubble = "Thinking…"
            try await wait(0.8 + Double.random(in: 0..<0.9))
            // They get worse as the easy answers come off the board.
            let pick = cpuPick(pHit: max(0.3, 0.82 - 0.1 * Double(shown.count)))
            try await rivalSay(pick.text)
            try await say("Survey says!")
            if let i = pick.index {
                try await reveal(i)
                if shown.count < n { try await cheer("Good answer!") }
            } else {
                try await strike(counts: true)
            }
        }

        if shown.count == n { return try await award(to: 1) }

        stage = .steal
        bubble = nil
        Task { await Voice.shared.crowd("Steal it!") }
        try await say("\(names[0]), confer with your family. One guess to steal \(bank * mult) points!")
        guard let text = await askGuess(.steal, timeout: 25) else {
            show("Time!", kind: .bad)
            try await strike(counts: false)
            return try await award(to: 1)
        }
        try Task.checkCancellation()
        async let verdict = evaluate(text)
        try await say("Survey says!")
        let i = await verdict
        if let i, !shown.contains(i) {
            try await reveal(i)
            try await cheer("Good answer!")
            return try await award(to: 0)
        }
        try await strike(counts: false)
        try await award(to: 1)
    }

    /// The audience reads out everything still hidden.
    private func revealRest() async throws {
        guard let b = board else { return }
        let rest = b.a.indices.filter { !shown.contains($0) }
        guard !rest.isEmpty else { return }
        try await say("Let's see what else the survey said.")
        for i in rest {
            SFX.flip()
            missed.insert(i)
            hot = i
            try await wait(0.38)
            try await cheer(b.a[i].text)
            try await wait(0.2)
        }
        hot = nil
    }

    private func runRound() async throws {
        let r = round
        stage = .loading
        line = ""
        bubble = nil
        qShown = false
        winner = nil

        let b: Survey
        if let prefetched = next {
            b = await prefetched.value
        } else {
            b = await API.shared.survey(avoid: seen)
        }
        try Task.checkCancellation()
        seen.append(b.q)

        // Write the next board, and the Fast Money set, while this one plays.
        let avoid = seen
        next = Task { [weak self] in
            let nb = await API.shared.survey(avoid: avoid)
            await MainActor.run { self?.warmBoard(nb, round: r + 1) }
            return nb
        }
        if fmBoards == nil && r == 0 {
            fmBoards = Task {
                var boards: [Survey] = []
                for _ in 0..<5 {
                    boards.append(await API.shared.survey(avoid: avoid, quick: true))
                }
                return boards
            }
        }

        board = b
        shown = []
        missed = []
        strikes = 0
        bank = 0
        mult = r < mults.count ? mults[r] : 3
        usedWrong = []
        hot = nil
        control = nil

        stage = .round
        let m = mult > 1 ? (mult == 2 ? " Double points!" : " Triple points!") : ""
        try await say("Round \(r + 1).\(m) Top \(b.a.count) answers on the board.")
        qShown = true
        try await say(b.q)

        let faceoffWinner = try await faceoff()
        if shown.count < b.a.count {
            var control = faceoffWinner
            if faceoffWinner == 0 {
                stage = .choose
                bubble = nil
                try await say("Play or pass?")
                let choice = await withCheckedContinuation { (c: CheckedContinuation<String, Never>) in
                    pendingChoice = c
                }
                try Task.checkCancellation()
                if choice == "pass" { control = 1 }
            }
            if control == 0 {
                try await youPlay()
            } else {
                try await cpuPlay()
            }
        } else {
            try await award(to: faceoffWinner)
        }
        try await revealRest()

        round += 1
        let (a, c) = (scores[0], scores[1])
        let over = (a >= showTarget || c >= showTarget || round >= maxRounds) && a != c
        guard over else {
            stage = .roundEnd
            return
        }

        let w = a > c ? 0 : 1
        winner = w
        stage = .gameOver
        if w == 0 {
            SFX.applause(4, 0.7)
            try await say("\(names[0]) win the game! You're going to Fast Money!")
        } else {
            SFX.groan()
            try await say("\(names[1]) win the game. Better luck next time!")
        }
    }

    /// Synthesises a board's lines before the round that needs them.
    private func warmBoard(_ b: Survey, round r: Int) {
        let mult = r < mults.count ? mults[r] : 3
        let m = mult > 1 ? (mult == 2 ? " Double points!" : " Triple points!") : ""
        var lines: [(role: VoiceRole, text: String)] = [
            (.host, "Round \(r + 1).\(m) Top \(b.a.count) answers on the board."),
            (.host, b.q),
        ]
        lines += b.wrong.prefix(4).map { (VoiceRole.rival, $0) }
        lines += b.a.map { (VoiceRole.rival, $0.text) }
        lines += b.a.map { (VoiceRole.crowd, $0.text) }
        Voice.shared.warm(lines)
    }

    // ── Entry points from the view ──

    /// Lines every episode uses, synthesised before they're needed.
    func warmCommonLines() {
        Voice.shared.warm([
            (.host, "Survey says!"),
            (.host, "Hands on your buzzers!"),
            (.host, "Back to the buzzers!"),
            (.host, "Play or pass?"),
            (.host, "Let's see what else the survey said."),
            (.crowd, "Good answer!"),
            (.crowd, "Steal it!"),
        ])
    }

    func start() {
        if names[0].trimmed.isEmpty { names[0] = "The Smiths" }
        Store.familyName = names[0]
        let avoid = seen
        next = Task { [weak self] in
            let b = await API.shared.survey(avoid: avoid)
            await MainActor.run { self?.warmBoard(b, round: 0) }
            return b
        }
        run {
            self.stage = .loading
            SFX.applause(2.2, 0.5)
            try await self.say(
                "Welcome to Crowd Says! Today it's \(self.names[0]) against \(self.names[1]). First family to \(showTarget) points wins!"
            )
            try await self.runRound()
        }
    }

    func nextRound() {
        run { try await self.runRound() }
    }

    /// Runs one leg of the episode, swallowing the cancellation that leaving
    /// the screen throws.
    private func run(_ body: @escaping () async throws -> Void) {
        director?.cancel()
        director = Task { [weak self] in
            do {
                try await body()
            } catch is CancellationError {
                // Left the screen mid-round; nothing to do.
            } catch {
                print("[crowd-says] \(error)")
            }
            _ = self
        }
    }

    func reset() {
        stop()
        stage = .intro
        scores = [0, 0]
        round = 0
        board = nil
        shown = []
        missed = []
        strikes = 0
        bank = 0
        mult = 1
        control = nil
        line = ""
        bubble = nil
        winner = nil
        usedWrong = []
        seen = []
        next = nil
        fmBoards = nil
        names = [names[0], rivals.randomElement() ?? "The Hendersons"]
    }

    func stop() {
        director?.cancel()
        director = nil
        next?.cancel()
        cancelGuess()
        if let c = pendingChoice {
            pendingChoice = nil
            c.resume(returning: "play")
        }
        Voice.shared.stop()
    }
}
