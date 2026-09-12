import SwiftUI

/// Round mode: the whole show, your family against a rival.
struct ShowView: View {
    let onHome: () -> Void
    @StateObject private var s = ShowModel()

    var body: some View {
        ZStack {
            StageBackground()

            if s.stage == .fastMoney {
                FastMoneyView(boards: s.fmBoards, name: s.names[0], onHome: onHome)
            } else {
                ScrollView {
                    VStack(spacing: 18) {
                        ShowBar(title: barTitle, backLabel: "Leave", onBack: onHome)

                        if s.stage == .intro {
                            IntroView(s: s)
                        } else {
                            Podiums(s: s)
                            HostLine(text: s.line)
                            boardSection
                            controls
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.bottom, 90)
                }
            }

            StrikeFlash(n: s.xs, stamp: s.flash)
            VStack {
                Spacer()
                ToastView(toast: s.toast).padding(.bottom, 100)
            }
        }
        .onAppear { s.warmCommonLines() }
        .onDisappear { s.stop() }
    }

    private var barTitle: String {
        var t: String
        switch s.stage {
        case .intro: t = "Round Mode"
        case .gameOver: t = "Final scores"
        case .roundEnd: t = "End of round \(s.round)"
        default: t = "Round \(s.round + 1)"
        }
        let playing = ![ShowStage.intro, .roundEnd, .gameOver].contains(s.stage)
        if s.mult > 1 && playing { t += s.mult == 2 ? " · Double" : " · Triple" }
        return t
    }

    @ViewBuilder
    private var boardSection: some View {
        if s.stage == .loading && s.board == nil {
            LoadingView(label: "Surveying 100 people…")
        } else if let b = s.board {
            // The question stays hidden until the host has introduced the round.
            QuestionText(text: s.qShown ? b.q : " ")
                .opacity(s.qShown ? 1 : 0.25)
            BoardView(answers: b.a, shown: s.shown, missed: s.missed, hot: s.hot)
            HStack {
                StrikesView(n: s.strikes)
                Spacer()
                VStack(alignment: .trailing, spacing: 0) {
                    Text("BANK")
                        .font(.system(size: 10, weight: .black))
                        .tracking(1.2)
                        .foregroundStyle(Color.ink2)
                    HStack(alignment: .firstTextBaseline, spacing: 3) {
                        Text("\(s.bank)").font(.display(24)).foregroundStyle(Color.gold)
                        if s.mult > 1 {
                            Text("×\(s.mult)")
                                .font(.system(size: 13, weight: .black))
                                .foregroundStyle(Color.gold2)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var controls: some View {
        VStack(spacing: 14) {
            if [ShowStage.faceoff, .play, .steal, .cpu, .round].contains(s.stage) {
                GuessBox(
                    placeholder: guessPlaceholder,
                    label: s.input?.label ?? "Guess",
                    disabled: s.input == nil || s.checking
                ) { s.submitGuess($0) }

                if let deadline = s.deadline {
                    TimerRing(deadline: deadline)
                }
            }

            if s.stage == .choose {
                HStack(spacing: 10) {
                    ShowButton(title: "Play", gold: true, big: true) { s.choose("play") }
                    ShowButton(title: "Pass", big: true) { s.choose("pass") }
                }
            }

            if s.stage == .roundEnd {
                ShowButton(title: "Next round ›", gold: true, big: true) { s.nextRound() }
            }

            if s.stage == .gameOver {
                VStack(spacing: 12) {
                    Text(s.winner == 0 ? "You win the game! 🏆" : "\(s.names[1]) win")
                        .font(.display(24))
                        .foregroundStyle(Color.gold)
                        .multilineTextAlignment(.center)
                    HStack(spacing: 10) {
                        if s.winner == 0 {
                            ShowButton(title: "Play Fast Money ⏱", gold: true, big: true) {
                                s.stage = .fastMoney
                            }
                        } else {
                            ShowButton(title: "Play again", gold: true, big: true) { s.reset() }
                        }
                        ShowButton(title: "Home", action: onHome)
                    }
                }
            }
        }
    }

    private var guessPlaceholder: String {
        if s.checking { return "Checking the survey…" }
        switch s.input {
        case .buzz: return "Type fast and hit Send to buzz in!"
        case .some: return "Type your answer…"
        case nil: return s.stage == .cpu ? "\(s.names[1]) are playing…" : "Wait for it…"
        }
    }
}

/// Tonight's episode: name your family, read the rules, start the show.
private struct IntroView: View {
    @ObservedObject var s: ShowModel

    private let rules = [
        "**Face-off:** type an answer and send it before the other family buzzes in. The top answer wins outright.",
        "**Play or pass:** win the face-off and choose who plays the board.",
        "**Three strikes** and the other family gets one guess to steal the bank.",
        "Round 3 is **double**, then **triple**. First to \(showTarget) goes to **Fast Money**.",
    ]

    var body: some View {
        VStack(spacing: 18) {
            QuestionText(text: "Your family vs. \(s.names[1])", kicker: "Tonight's episode")

            VStack(alignment: .leading, spacing: 6) {
                Text("Your family name")
                    .font(.system(size: 12, weight: .bold))
                    .tracking(1.1)
                    .textCase(.uppercase)
                    .foregroundStyle(Color.ink2)
                TextField("The Smiths", text: $s.names[0])
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color.ink)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 13)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Color.black.opacity(0.3)))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.white.opacity(0.2), lineWidth: 1))
                    .onChange(of: s.names[0]) { _, new in
                        if new.count > 24 { s.names[0] = String(new.prefix(24)) }
                    }
            }

            VStack(alignment: .leading, spacing: 10) {
                ForEach(rules, id: \.self) { rule in
                    Text((try? AttributedString(markdown: rule)) ?? AttributedString(rule))
                        .font(.system(size: 14))
                        .foregroundStyle(Color.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 14).fill(Color.black.opacity(0.2)))

            ShowButton(title: "Let's play! 🎬", gold: true, big: true) { s.start() }
        }
    }
}

/// The two podiums with their running scores.
private struct Podiums: View {
    @ObservedObject var s: ShowModel

    var body: some View {
        HStack(spacing: 12) {
            ForEach(0..<2, id: \.self) { i in
                let lit = (s.control == i && (s.stage == .play || s.stage == .cpu))
                    || (s.stage == .steal && s.control != i)
                VStack(spacing: 4) {
                    Text(i == 0 ? "\(s.names[i]) (you)" : s.names[i])
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(Color.ink2)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    Text("\(s.scores[i])")
                        .font(.display(30))
                        .foregroundStyle(s.winner == i ? Color.gold : Color.ink)
                    // The rival family thinking out loud.
                    if i == 1, let bubble = s.bubble {
                        Text(bubble)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Color.navy)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(Capsule().fill(Color.gold))
                            .lineLimit(2)
                            .minimumScaleFactor(0.7)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(
                    RoundedRectangle(cornerRadius: 14)
                        .fill(lit ? Color.showBlue.opacity(0.55) : Color.black.opacity(0.25))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 14)
                        .stroke(lit ? Color.gold : Color.white.opacity(0.15), lineWidth: lit ? 2 : 1)
                )
                .animation(.easeInOut(duration: 0.25), value: lit)
            }
        }
    }
}

/// The countdown on a timed answer.
struct TimerRing: View {
    let deadline: Date

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.1)) { context in
            let left = max(0, deadline.timeIntervalSince(context.date))
            Text("\(Int(left.rounded(.up)))")
                .font(.display(26))
                .monospacedDigit()
                .foregroundStyle(left <= 5 ? Color.showRed : Color.gold)
                .frame(width: 54, height: 54)
                .background(Circle().fill(Color.black.opacity(0.3)))
                .overlay(Circle().stroke(left <= 5 ? Color.showRed : Color.gold, lineWidth: 2))
        }
    }
}
