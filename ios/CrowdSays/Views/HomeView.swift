import SwiftUI

/// The welcome page: the marquee, the three modes, a board that plays itself,
/// and the scoreboard tape.
struct HomeView: View {
    let go: (Screen) -> Void

    @State private var day = dayNumber()
    @State private var today: DailyProgress?
    @State private var stats = Stats()
    @State private var leaving: Screen?

    private var started: Bool { today?.isStarted ?? false }
    private var done: Bool { today?.isOver ?? false }

    private var dailyLabel: String {
        if done { return "Played — see your result and share it" }
        if started { return "Pick up where you left off" }
        return "One survey, three strikes. The same board everyone else is playing."
    }

    private var playLabel: String {
        if done { return "See today's result" }
        if started { return "Resume today's board" }
        return "Play today's board"
    }

    var body: some View {
        ZStack {
            StageBackground()

            ScrollView {
                VStack(spacing: 26) {
                    marquee
                    modes
                    DemoBoard()
                    howItWorks
                    whatsInside
                    closer
                    tape
                }
                .padding(.horizontal, 18)
                .padding(.top, 30)
                .padding(.bottom, 100)
            }

            CurtainView()
        }
        .onAppear {
            day = dayNumber()
            today = Store.daily(day)
            stats = Store.stats
        }
    }

    // ── Sections ──

    private var marquee: some View {
        VStack(spacing: 14) {
            HStack(spacing: 7) {
                Circle().fill(Color.showRed).frame(width: 8, height: 8)
                Text("ON AIR · BOARD #\(day)")
                    .font(.system(size: 11, weight: .black))
                    .tracking(1.6)
                    .foregroundStyle(Color.ink2)
            }

            VStack(spacing: -8) {
                Text("CROWD")
                    .font(.display(50))
                    .foregroundStyle(Color.ink)
                Text("SAYS!")
                    .font(.display(58))
                    .foregroundStyle(
                        LinearGradient(colors: [.gold, .gold2], startPoint: .top, endPoint: .bottom)
                    )
            }
            .tracking(1)
            .rotationEffect(.degrees(-4))
            .shadow(color: .black.opacity(0.4), radius: 8, y: 4)

            Text("We asked 100 people. Can you guess what they said?")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Color.ink2)
                .multilineTextAlignment(.center)

            ShowButton(title: playLabel, gold: true, big: true) { start(.daily) }
        }
        .padding(.vertical, 24)
        .padding(.horizontal, 18)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 20)
                .fill(Color.black.opacity(0.22))
                .overlay(
                    RoundedRectangle(cornerRadius: 20)
                        .stroke(Color.gold.opacity(0.45), lineWidth: 2)
                )
        )
    }

    private var modes: some View {
        VStack(spacing: 10) {
            ForEach(Array(Screen.modes.enumerated()), id: \.element) { n, mode in
                Button { start(mode) } label: {
                    HStack(spacing: 14) {
                        Text("\(n + 1)")
                            .font(.display(26))
                            .foregroundStyle(mode == .daily ? Color.gold : Color.ink2)
                            .frame(width: 30)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(mode == .daily ? "\(mode.title) #\(day)" : mode.title)
                                .font(.system(size: 17, weight: .heavy))
                                .foregroundStyle(Color.ink)
                            Text(mode == .daily ? dailyLabel : mode.blurb)
                                .font(.system(size: 13))
                                .foregroundStyle(Color.ink2)
                                .multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                        Text("▸").foregroundStyle(Color.gold)
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity)
                    .background(
                        RoundedRectangle(cornerRadius: 16)
                            .fill(mode == .daily ? Color.gold.opacity(0.12) : Color.black.opacity(0.25))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 16)
                            .stroke(mode == .daily ? Color.gold.opacity(0.6) : Color.white.opacity(0.14), lineWidth: 1)
                    )
                    .scaleEffect(leaving == mode ? 0.96 : 1)
                    .opacity(leaving != nil && leaving != mode ? 0.4 : 1)
                }
                .buttonStyle(.plain)
            }
        }
        .animation(.easeOut(duration: 0.25), value: leaving)
    }

    private var howItWorks: some View {
        HomeSection(title: "How it works") {
            VStack(spacing: 10) {
                ForEach(Array(HomeCopy.steps.enumerated()), id: \.offset) { n, step in
                    HStack(alignment: .top, spacing: 12) {
                        Text("\(n + 1)")
                            .font(.display(18))
                            .foregroundStyle(Color.navy)
                            .frame(width: 26, height: 26)
                            .background(Circle().fill(Color.gold))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(step.0).font(.system(size: 15, weight: .heavy)).foregroundStyle(Color.ink)
                            Text(step.1).font(.system(size: 13)).foregroundStyle(Color.ink2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
        }
    }

    private var whatsInside: some View {
        HomeSection(title: "What's inside") {
            LazyVGrid(columns: [GridItem(spacing: 10), GridItem(spacing: 10)], spacing: 10) {
                ForEach(HomeCopy.features, id: \.1) { icon, title, blurb in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(icon).font(.system(size: 22))
                        Text(title).font(.system(size: 14, weight: .heavy)).foregroundStyle(Color.ink)
                        Text(blurb).font(.system(size: 12)).foregroundStyle(Color.ink2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Color.black.opacity(0.22)))
                }
            }
        }
    }

    private var closer: some View {
        VStack(spacing: 12) {
            Text("Ready? Board #\(day) is waiting.")
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(Color.ink)
            ShowButton(title: playLabel, gold: true, big: true) { start(.daily) }
        }
        .padding(.vertical, 8)
    }

    private var tape: some View {
        // Only the numbers you actually have.
        let streak = stats.currentStreak(today: day)
        return HStack(spacing: 14) {
            if streak > 0 { Text("🔥 \(streak) day streak") }
            if stats.played > 0 { Text("\(stats.played) played") }
            if stats.best > 0 { Text("best \(stats.best)") }
            CountdownText(prefix: "next board in")
        }
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(Color.ink2)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.black.opacity(0.2)))
    }

    private func start(_ screen: Screen) {
        guard leaving == nil else { return }
        SFX.ding()
        leaving = screen
        Task {
            try? await Task.sleep(nanoseconds: 260_000_000)
            go(screen)
            leaving = nil
        }
    }
}

/// A gold section heading.
private struct HomeSection<Content: View>: View {
    let title: String
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title.uppercased())
                .font(.display(18))
                .tracking(1.4)
                .foregroundStyle(Color.gold)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

enum HomeCopy {
    static let steps: [(String, String)] = [
        ("Read the survey", "One question, put to 100 people."),
        ("Guess the answers", "Type what you think they said — close enough counts."),
        ("Beat the board", "Clear all eight before three strikes."),
    ]

    static let features: [(String, String, String)] = [
        ("📋", "A new board daily", "Everyone plays the same survey, same day — then compare grids."),
        ("🎙️", "A host who talks", "Studio voices read the question and call out every answer."),
        ("🎬", "The whole show", "Face-offs, steals, double and triple rounds, then Fast Money."),
        ("🔥", "Streaks and ranks", "Your run, your best score, and a spoiler-free grid to share."),
        ("♾️", "Endless practice", "Fresh boards whenever you want. Nothing on the line."),
        ("🚫", "No signup, no ads", "Open it and play. Progress lives on your device."),
    ]
}

/// A board that plays itself — the same BoardView the real game uses, so the
/// welcome page shows the actual thing rather than a picture of it.
private struct DemoBoard: View {
    @State private var shown: Set<Int> = []
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let demo = QuestionBank.all.first

    var body: some View {
        if let demo {
            HomeSection(title: "Here's a board") {
                VStack(spacing: 14) {
                    QuestionText(text: demo.q, kicker: "Survey says")
                    BoardView(answers: demo.a, shown: shown)
                    Text("Type a guess, the board opens. Three strikes and the round is over.")
                        .font(.system(size: 12))
                        .foregroundStyle(Color.ink2)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                }
            }
            .task {
                // Under reduced motion it just sits there, fully open.
                if reduceMotion {
                    shown = Set(demo.a.indices)
                    return
                }
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    if shown.count >= demo.a.count {
                        shown = []
                    } else {
                        shown.insert(shown.count)
                    }
                }
            }
        }
    }
}

/// The curtain opens once per launch — nobody wants the whole overture again
/// just because they hit Home.
private struct CurtainView: View {
    @State private var open = Store.sawCurtain
    @State private var gone = Store.sawCurtain
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            if !gone {
                GeometryReader { geo in
                    HStack(spacing: 0) {
                        curtainHalf.frame(width: geo.size.width / 2)
                            .offset(x: open ? -geo.size.width / 2 : 0)
                        curtainHalf.frame(width: geo.size.width / 2)
                            .offset(x: open ? geo.size.width / 2 : 0)
                    }
                    .animation(.easeInOut(duration: 1.2), value: open)
                }
                .ignoresSafeArea()
                .allowsHitTesting(false)
            }
        }
        .task {
            guard !Store.sawCurtain else { return }
            Store.sawCurtain = true
            if reduceMotion {
                open = true
                gone = true
                return
            }
            try? await Task.sleep(nanoseconds: 60_000_000)
            open = true
            // Dropped once it has animated, so it can't eat taps.
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            gone = true
        }
    }

    private var curtainHalf: some View {
        LinearGradient(
            colors: [
                Color(red: 0.42, green: 0.04, blue: 0.09),
                Color(red: 0.60, green: 0.07, blue: 0.13),
                Color(red: 0.34, green: 0.03, blue: 0.07),
            ],
            startPoint: .leading,
            endPoint: .trailing
        )
    }
}
