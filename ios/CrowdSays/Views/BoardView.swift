import SwiftUI

/*
  The answer board: eight slots in two columns, like the show. `shown` holds
  revealed indices; `missed` holds the ones called out at the end that nobody
  got, drawn muted. A tile that opens does a full panel rotation and counts
  its points up.
*/
struct BoardView: View {
    let answers: [Answer]
    let shown: Set<Int>
    var missed: Set<Int> = []
    /// The tile currently being revealed, which gets the light sweep.
    var hot: Int?
    var onTile: ((Int) -> Void)?

    /// Column-major: 1–4 down the left, 5–8 down the right.
    private var order: [Int] {
        let half = (answers.count + 1) / 2
        return (0..<half).flatMap { row -> [Int] in
            let right = row + half
            return right < answers.count ? [row, right] : [row, -1]
        }
    }

    var body: some View {
        LazyVGrid(columns: [GridItem(spacing: 10), GridItem(spacing: 10)], spacing: 10) {
            ForEach(Array(order.enumerated()), id: \.offset) { _, i in
                if i < 0 || i >= answers.count {
                    EmptyTile()
                } else {
                    TileView(
                        index: i,
                        answer: answers[i],
                        open: shown.contains(i) || missed.contains(i),
                        missed: missed.contains(i),
                        hot: hot == i,
                        onTap: onTile.map { f in { f(i) } }
                    )
                }
            }
        }
    }
}

private struct EmptyTile: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 10)
            .fill(Color.black.opacity(0.18))
            .frame(height: 58)
    }
}

private struct TileView: View {
    let index: Int
    let answer: Answer
    let open: Bool
    let missed: Bool
    let hot: Bool
    let onTap: (() -> Void)?

    var body: some View {
        Button {
            onTap?()
        } label: {
            ZStack {
                if open {
                    // The revealed panel: answer on the left, points on the right.
                    HStack(spacing: 6) {
                        Text(answer.text.uppercased())
                            .font(.system(size: 14, weight: .heavy))
                            .foregroundStyle(missed ? Color.ink2 : Color.ink)
                            .lineLimit(2)
                            .minimumScaleFactor(0.65)
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 2)
                        CountUpText(to: answer.points, run: open)
                            .font(.display(20))
                            .foregroundStyle(missed ? Color.ink2 : Color.gold)
                    }
                    .padding(.horizontal, 12)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(
                        RoundedRectangle(cornerRadius: 10).fill(
                            missed
                                ? AnyShapeStyle(Color.white.opacity(0.07))
                                : AnyShapeStyle(LinearGradient(
                                    colors: [.showBlue2, .showBlue],
                                    startPoint: .top, endPoint: .bottom
                                ))
                        )
                    )
                    // The flip lands face-forward: undo the parent rotation.
                    .rotation3DEffect(.degrees(180), axis: (x: 0, y: 1, z: 0))
                } else {
                    Text("\(index + 1)")
                        .font(.display(24))
                        .foregroundStyle(Color.gold.opacity(0.9))
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(
                            RoundedRectangle(cornerRadius: 10).fill(
                                LinearGradient(
                                    colors: [Color.navy2, Color.navy],
                                    startPoint: .top, endPoint: .bottom
                                )
                            )
                        )
                }
            }
            .frame(height: 58)
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(hot ? Color.gold : Color.white.opacity(0.18), lineWidth: hot ? 2 : 1)
            )
            .rotation3DEffect(.degrees(open ? 180 : 0), axis: (x: 0, y: 1, z: 0))
            .animation(.easeInOut(duration: 0.42), value: open)
        }
        .buttonStyle(.plain)
        .disabled(onTap == nil || open)
        .accessibilityLabel(open ? "\(answer.text), \(answer.points) points" : "Answer \(index + 1), hidden")
    }
}

/// Counts 0 → `to` once `run` turns true, after the flip lands.
struct CountUpText: View {
    let to: Int
    let run: Bool
    var delay: Double = 0.38
    var duration: Double = 0.52

    @State private var value = 0

    var body: some View {
        Text("\(value)")
            .monospacedDigit()
            .task(id: run) {
                guard run else {
                    value = 0
                    return
                }
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                let steps = 26
                for s in 0...steps {
                    if Task.isCancelled { return }
                    let t = Double(s) / Double(steps)
                    // Cubic ease-out, as on the web.
                    value = Int((Double(to) * (1 - pow(1 - t, 3))).rounded())
                    try? await Task.sleep(nanoseconds: UInt64(duration / Double(steps) * 1_000_000_000))
                }
                value = to
            }
    }
}

/// The three strike pips under the board.
struct StrikesView: View {
    let n: Int
    var max = 3

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<max, id: \.self) { i in
                Text("✕")
                    .font(.system(size: 18, weight: .black))
                    .foregroundStyle(i < n ? Color.showRed : Color.white.opacity(0.18))
                    .scaleEffect(i < n ? 1.1 : 1)
                    .animation(.spring(response: 0.3, dampingFraction: 0.5), value: n)
            }
        }
        .accessibilityLabel("\(n) of \(max) strikes")
    }
}

/// Big red X's that slam onto the screen, then clear. `stamp` retriggers them.
struct StrikeFlash: View {
    let n: Int
    let stamp: Int

    @State private var visible = false
    @State private var scale: CGFloat = 2.4

    var body: some View {
        ZStack {
            if visible {
                HStack(spacing: 10) {
                    ForEach(0..<Swift.max(1, n), id: \.self) { _ in
                        Text("✕")
                            .font(.system(size: 110, weight: .black))
                            .foregroundStyle(Color.showRed)
                            .shadow(color: .black.opacity(0.6), radius: 12)
                    }
                }
                .scaleEffect(scale)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .allowsHitTesting(false)
        .task(id: stamp) {
            guard stamp != 0 else { return }
            scale = 2.4
            visible = true
            withAnimation(.spring(response: 0.28, dampingFraction: 0.6)) { scale = 1 }
            try? await Task.sleep(nanoseconds: 1_100_000_000)
            visible = false
        }
        .accessibilityHidden(true)
    }
}

/// The guess field and its submit button.
struct GuessBox: View {
    var placeholder = "Type a guess…"
    var label = "Guess"
    var disabled = false
    var autoFocus = true
    let onGuess: (String) -> Void

    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 8) {
            TextField(placeholder, text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Color.ink)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .submitLabel(.send)
                .focused($focused)
                .disabled(disabled)
                .onSubmit(submit)
                .padding(.horizontal, 14)
                .padding(.vertical, 13)
                .background(RoundedRectangle(cornerRadius: 12).fill(Color.black.opacity(0.3)))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.white.opacity(0.2), lineWidth: 1))
                .onChange(of: text) { _, new in
                    if new.count > 60 { text = String(new.prefix(60)) }
                }

            ShowButton(title: label, gold: true, enabled: !disabled && !text.trimmed.isEmpty, action: submit)
        }
        .onChange(of: disabled) { _, isDisabled in
            if !isDisabled && autoFocus { focused = true }
        }
        .onAppear { if !disabled && autoFocus { focused = true } }
    }

    private func submit() {
        let t = text.trimmed
        guard !t.isEmpty, !disabled else { return }
        onGuess(t)
        text = ""
    }
}

/// A short message over the board — "Survey says… 32!", "Time!".
struct ToastMessage: Equatable, Identifiable {
    enum Kind { case info, good, bad }
    let id = UUID()
    var text: String
    var kind: Kind = .info

    static func == (a: ToastMessage, b: ToastMessage) -> Bool { a.id == b.id }
}

struct ToastView: View {
    let toast: ToastMessage?

    var body: some View {
        ZStack {
            if let toast {
                Text(toast.text)
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(toast.kind == .good ? Color.navy : Color.ink)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 11)
                    .background(
                        Capsule().fill(
                            toast.kind == .good
                                ? AnyShapeStyle(LinearGradient(colors: [.gold, .gold2], startPoint: .top, endPoint: .bottom))
                                : AnyShapeStyle(toast.kind == .bad ? Color.showRed.opacity(0.9) : Color.black.opacity(0.75))
                        )
                    )
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .id(toast.id)
            }
        }
        .animation(.spring(response: 0.32, dampingFraction: 0.8), value: toast)
    }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
