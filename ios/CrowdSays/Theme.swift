import SwiftUI

/// The show's palette, carried over from src/styles.css.
extension Color {
    static let navy = Color(red: 0x07 / 255, green: 0x12 / 255, blue: 0x3a / 255)
    static let navy2 = Color(red: 0x0c / 255, green: 0x1d / 255, blue: 0x5c / 255)
    static let showBlue = Color(red: 0x16 / 255, green: 0x46 / 255, blue: 0xc8 / 255)
    static let showBlue2 = Color(red: 0x2c / 255, green: 0x6b / 255, blue: 0xff / 255)
    static let gold = Color(red: 0xff / 255, green: 0xc5 / 255, blue: 0x3d / 255)
    static let gold2 = Color(red: 0xff / 255, green: 0x9d / 255, blue: 0x00 / 255)
    static let showRed = Color(red: 0xff / 255, green: 0x3b / 255, blue: 0x3b / 255)
    static let ink = Color(red: 0xf4 / 255, green: 0xf7 / 255, blue: 0xff / 255)
    static let ink2 = Color(red: 0xb7 / 255, green: 0xc3 / 255, blue: 0xea / 255)
}

extension Font {
    /// Stands in for Anton: heavy, tight and condensed-feeling.
    static func display(_ size: CGFloat) -> Font {
        .system(size: size, weight: .black, design: .default)
    }
}

/// The studio: a deep blue wash with lights sweeping slowly behind everything.
struct StageBackground: View {
    @State private var sweep = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            RadialGradient(
                colors: [Color(red: 0x1c / 255, green: 0x3a / 255, blue: 0xa8 / 255), .navy2, .navy],
                center: UnitPoint(x: 0.5, y: -0.1),
                startRadius: 0,
                endRadius: 900
            )

            if !reduceMotion {
                GeometryReader { geo in
                    ZStack {
                        ForEach(0..<2, id: \.self) { i in
                            LinearGradient(
                                colors: [Color(red: 0.47, green: 0.67, blue: 1).opacity(0.16), .clear],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                            .frame(width: geo.size.width * 0.6, height: geo.size.height * 1.6)
                            .blur(radius: 30)
                            .rotationEffect(
                                .degrees(sweep ? (i == 0 ? 18 : -18) : (i == 0 ? -18 : 18)),
                                anchor: .top
                            )
                            .offset(x: i == 0 ? -geo.size.width * 0.1 : geo.size.width * 0.1, y: -geo.size.height * 0.4)
                            .animation(
                                .easeInOut(duration: 9).repeatForever(autoreverses: true).delay(i == 0 ? 0 : 1),
                                value: sweep
                            )
                        }
                    }
                }
                .allowsHitTesting(false)
            }
        }
        .ignoresSafeArea()
        .onAppear { sweep = true }
    }
}

// ── Shared chrome ──

/// The gold uppercase title bar with a back button, as on every screen.
struct ShowBar: View {
    let title: String
    var backLabel = "Home"
    let onBack: () -> Void

    var body: some View {
        HStack {
            Button(action: onBack) {
                Text("‹ \(backLabel)")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.ink2)
            }
            Spacer()
            Text(title.uppercased())
                .font(.display(17))
                .tracking(1.2)
                .foregroundStyle(Color.gold)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Spacer()
            // Balances the back button so the title stays centred.
            Text("‹ \(backLabel)")
                .font(.system(size: 15, weight: .semibold))
                .opacity(0)
        }
    }
}

/// "We asked 100 people…" over the question itself.
struct QuestionText: View {
    let text: String
    var kicker = "We asked 100 people…"

    var body: some View {
        VStack(spacing: 8) {
            Text(kicker)
                .font(.system(size: 12, weight: .bold))
                .tracking(1.4)
                .textCase(.uppercase)
                .foregroundStyle(Color.gold.opacity(0.85))
            Text(text)
                .font(.display(26))
                .multilineTextAlignment(.center)
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
    }
}

/// The show's button, in gold and plain variants.
struct ShowButton: View {
    let title: String
    var gold = false
    var big = false
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: big ? 18 : 15, weight: .bold))
                .foregroundStyle(gold ? Color.navy : Color.ink)
                .padding(.horizontal, big ? 26 : 18)
                .padding(.vertical, big ? 15 : 11)
                .background(
                    Capsule().fill(
                        gold
                            ? AnyShapeStyle(LinearGradient(colors: [.gold, .gold2], startPoint: .top, endPoint: .bottom))
                            : AnyShapeStyle(Color.white.opacity(0.1))
                    )
                )
                .overlay(Capsule().stroke(gold ? Color.clear : Color.white.opacity(0.22), lineWidth: 1))
        }
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
    }
}

/// The host's line, under the podiums.
struct HostLine: View {
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text("🎤")
            Text(text.isEmpty ? "…" : text)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.black.opacity(0.22)))
        .accessibilityAddTraits(.updatesFrequently)
    }
}

/// "Polling 100 strangers…" — the wait while a board is written.
struct LoadingView: View {
    static let lines = [
        "Polling 100 strangers…",
        "Tallying the clipboard…",
        "Bribing the focus group…",
        "Counting the hands…",
    ]

    var label: String?
    @State private var i = 0
    @State private var bounce = false

    var body: some View {
        VStack(spacing: 14) {
            HStack(spacing: 7) {
                ForEach(0..<3, id: \.self) { n in
                    Circle()
                        .fill(Color.gold)
                        .frame(width: 10, height: 10)
                        .scaleEffect(bounce ? 1 : 0.5)
                        .animation(
                            .easeInOut(duration: 0.5).repeatForever().delay(Double(n) * 0.15),
                            value: bounce
                        )
                }
            }
            Text(label ?? LoadingView.lines[i])
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color.ink2)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 36)
        .onAppear { bounce = true }
        .task {
            guard label == nil else { return }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_400_000_000)
                i = (i + 1) % LoadingView.lines.count
            }
        }
    }
}
