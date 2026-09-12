import SwiftUI

/// The screens the app moves between — the native stand-in for the web
/// game's hash routes.
enum Screen: Hashable {
    case home, daily, practice, rounds

    static let modes: [Screen] = [.daily, .practice, .rounds]

    var title: String {
        switch self {
        case .home: return "Crowd Says"
        case .daily: return "Today's Board"
        case .practice: return "Practice Mode"
        case .rounds: return "Round Mode"
        }
    }

    var blurb: String {
        switch self {
        case .daily: return "One survey, three strikes. The same board everyone else is playing."
        case .practice: return "Endless fresh boards, just you and the survey. Nothing counts."
        case .rounds: return "The full show — your family vs. a rival. Face-offs, steals, then Fast Money."
        case .home: return ""
        }
    }
}

struct RootView: View {
    @State private var screen: Screen = .home
    @State private var showSettings = false

    var body: some View {
        ZStack {
            switch screen {
            case .home:
                HomeView { screen = $0 }
            case .daily:
                DailyScreen { screen = .home }
            case .practice:
                PracticeScreen { screen = .home }
            case .rounds:
                ShowView { screen = .home }
            }

            // The floating sound button, on every screen.
            VStack {
                Spacer()
                HStack {
                    Spacer()
                    SoundButton(showSettings: $showSettings)
                        .padding(.trailing, 18)
                        .padding(.bottom, 22)
                }
            }
        }
        .preferredColorScheme(.dark)
        .sheet(isPresented: $showSettings) { SettingsSheet() }
        .onAppear { AudioEngine.shared.start() }
    }
}

private struct SoundButton: View {
    @Binding var showSettings: Bool
    @ObservedObject private var voice = Voice.shared
    @State private var muted = AudioEngine.shared.isMuted

    var body: some View {
        Button { showSettings = true } label: {
            Text(muted ? "🔇" : voice.engine == .off ? "🔈" : "🔊")
                .font(.system(size: 20))
                .frame(width: 48, height: 48)
                .background(Circle().fill(Color.black.opacity(0.55)))
                .overlay(Circle().stroke(Color.white.opacity(0.2), lineWidth: 1))
        }
        .accessibilityLabel("Sound settings")
        .onChange(of: showSettings) { _, _ in muted = AudioEngine.shared.isMuted }
    }
}

/// Voices, muting, and where the survey writer lives.
struct SettingsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var voice = Voice.shared
    @State private var muted = AudioEngine.shared.isMuted
    @State private var server = Store.serverURL
    @State private var statusTask: Task<Void, Never>?

    private var studioNote: String? {
        guard voice.engine == .studio else { return nil }
        let st = voice.ttsStatus
        if st.ready { return "Ready." }
        if let failed = st.failed { return "Unavailable (\(failed)). Using iPhone voices." }
        return "Waking the voice server…"
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Voices") {
                    ForEach(VoiceEngine.allCases) { e in
                        Button {
                            voice.engine = e
                            if e == .studio { pollStatus() }
                        } label: {
                            HStack(alignment: .top) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(e.label).foregroundStyle(.primary)
                                    Text(e == .studio ? (studioNote ?? e.note) : e.note)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if voice.engine == e {
                                    Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                                }
                            }
                        }
                    }
                }

                Section {
                    Toggle("Mute everything", isOn: $muted)
                        .onChange(of: muted) { _, m in AudioEngine.shared.isMuted = m }
                    Button("Test the crowd ▶") {
                        SFX.ding()
                        Task { await Voice.shared.crowd("Good answer!") }
                    }
                }

                Section {
                    TextField("https://your-server.example", text: $server)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .onChange(of: server) { _, v in Store.serverURL = v }
                } header: {
                    Text("Survey server")
                } footer: {
                    Text(server.trimmed.isEmpty
                        ? "Empty: the app plays offline from its built-in question bank, using iPhone voices. Add your Crowd Says server to get AI-written boards, the answer referee and the studio voices."
                        : "AI-written daily and practice boards, the answer referee and the studio voices all come from here.")
                }
            }
            .navigationTitle("Sound & voices")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .onAppear { if voice.engine == .studio { pollStatus() } }
        .onDisappear { statusTask?.cancel() }
    }

    private func pollStatus() {
        statusTask?.cancel()
        statusTask = Task { await Voice.shared.refreshStatus() }
    }
}
