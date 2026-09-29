import SwiftUI

@main
struct EC2RemoteApp: App {
    @StateObject private var store = GatewayStore()
    @StateObject private var lock = AppLock()
    @StateObject private var web = WebController()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .environmentObject(lock)
                .environmentObject(web)
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background: lock.didEnterBackground()
            case .active: lock.willEnterForeground()
            default: break
            }
        }
    }
}

struct RootView: View {
    @EnvironmentObject var store: GatewayStore
    @EnvironmentObject var lock: AppLock
    @EnvironmentObject var web: WebController
    @State private var settingsOpen = false
    @State private var pairError: String?

    var body: some View {
        ZStack {
            if let g = store.selected {
                SessionScreen(gateway: g, settingsOpen: $settingsOpen)
            } else {
                PairingView()
            }
            // The lock covers the web view instead of replacing it, so sessions keep running underneath.
            // Nothing to protect until a computer is paired.
            if lock.locked && lock.enabled && !store.gateways.isEmpty { LockScreen(lock: lock).transition(.opacity) }
        }
        .sheet(isPresented: $settingsOpen) { SettingsView() }
        .onAppear {
            web.onOpenSettings = { settingsOpen = true }
            #if DEBUG
            // Simulator automation: SIMCTL_CHILD_EC2R_PAIR="<pairing link>" pairs on launch (no camera, no URL prompt).
            if let link = ProcessInfo.processInfo.environment["EC2R_PAIR"], let g = try? Pairing.parse(link) { store.add(g) }
            #endif
        }
        .onOpenURL { url in pair(from: url) }
        .alert("Pairing failed", isPresented: Binding(get: { pairError != nil }, set: { if !$0 { pairError = nil } })) {
            Button("OK", role: .cancel) { pairError = nil }
        } message: { Text(pairError ?? "") }
    }
}

extension RootView {
    /// ec2remote://pair?url=<https://host/#token=…> (the fragment must be percent-encoded inside `url`).
    func pair(from url: URL) {
        guard url.scheme == "ec2remote", url.host == "pair",
              let link = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "url" })?.value else { return }
        Task {
            do {
                let g = try Pairing.parse(link)
                try await Pairing.verify(g)
                store.add(g)
            } catch {
                pairError = error.localizedDescription
            }
        }
    }
}

struct SessionScreen: View {
    let gateway: Gateway
    @Binding var settingsOpen: Bool
    @EnvironmentObject var web: WebController

    var body: some View {
        ZStack {
            Color(uiColor: .systemBackground).ignoresSafeArea()
            WebViewHost(controller: web)
                .ignoresSafeArea(.container)
                .opacity(web.phase == .ready ? 1 : 0.001)
            switch web.phase {
            case .loading:
                VStack(spacing: 14) {
                    ProgressView()
                    Text("Connecting to \(gateway.name)…").foregroundStyle(.secondary)
                }
            case .failed(let why):
                ConnectionErrorView(gateway: gateway, message: why, settingsOpen: $settingsOpen)
            case .ready:
                EmptyView()
            }
        }
        .onAppear { web.open(gateway) }
        .onChange(of: gateway) { _, g in web.open(g) }
        .sheet(item: Binding(get: { web.shareURL.map(SharedFile.init) }, set: { if $0 == nil { web.shareURL = nil } })) { f in
            ShareSheet(url: f.url).presentationDetents([.medium, .large])
        }
    }
}

private struct SharedFile: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

struct ConnectionErrorView: View {
    let gateway: Gateway
    let message: String
    @Binding var settingsOpen: Bool
    @EnvironmentObject var web: WebController

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "wifi.exclamationmark").font(.system(size: 46)).foregroundStyle(.orange)
            Text("Can't reach \(gateway.name)").font(.title2.bold()).multilineTextAlignment(.center)
            Text(message).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Text(gateway.displayHost).font(.footnote.monospaced()).foregroundStyle(.tertiary)
            VStack(spacing: 10) {
                Button { web.reload() } label: { Label("Try again", systemImage: "arrow.clockwise").frame(maxWidth: 280) }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                if let tailscale = URL(string: "tailscale://"), UIApplication.shared.canOpenURL(tailscale) {
                    Button("Open Tailscale") { UIApplication.shared.open(tailscale) }.buttonStyle(.bordered).controlSize(.large)
                }
                Button("Computers & settings") { settingsOpen = true }.controlSize(.large)
            }
        }
        .padding(32)
        .frame(maxWidth: 520)
    }
}

struct SettingsView: View {
    @EnvironmentObject var store: GatewayStore
    @EnvironmentObject var lock: AppLock
    @EnvironmentObject var web: WebController
    @Environment(\.dismiss) private var dismiss
    @State private var pairing = false
    @State private var renaming: Gateway?
    @State private var newName = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(store.gateways) { g in
                        Button {
                            store.selectedID = g.id
                            dismiss()
                        } label: {
                            HStack {
                                Image(systemName: "desktopcomputer").foregroundStyle(Color.accentColor)
                                VStack(alignment: .leading) {
                                    Text(g.name).foregroundStyle(.primary)
                                    Text(g.displayHost).font(.caption.monospaced()).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if g.id == store.selected?.id { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                            }
                        }
                        .swipeActions {
                            Button("Remove", role: .destructive) { store.remove(g.id) }
                            Button("Rename") { renaming = g; newName = g.name }.tint(.indigo)
                        }
                    }
                    Button { pairing = true } label: { Label("Pair another computer", systemImage: "qrcode.viewfinder") }
                } header: {
                    Text("Computers")
                } footer: {
                    Text("Swipe left to rename or remove. Pairing again with the same computer replaces its token.")
                }

                Section("Security") {
                    Toggle("Lock with \(lock.biometryName)", isOn: $lock.enabled)
                    if lock.enabled {
                        Picker("Require after", selection: $lock.lockAfterMinutes) {
                            Text("Immediately").tag(0)
                            Text("1 minute").tag(1)
                            Text("5 minutes").tag(5)
                            Text("15 minutes").tag(15)
                        }
                    }
                }

                Section {
                    Toggle("Keep screen on during sessions", isOn: $web.keepAwake)
                        .onChange(of: web.keepAwake) { _, _ in web.updateIdleTimer() }
                    Button("Reload") { web.reload(); dismiss() }
                } header: {
                    Text("Sessions")
                } footer: {
                    Text("When you switch apps, iOS pauses EC2 Remote. Sessions stay open on the computer for 10 minutes and pick up where they were when you come back.")
                }

                Section {
                    LabeledContent("Version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "–")
                }
            }
            .navigationTitle("EC2 Remote")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(isPresented: $pairing) { PairingView(isSheet: true) }
            .alert("Rename", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Name", text: $newName)
                Button("Save") { if let g = renaming { store.rename(g.id, to: newName) }; renaming = nil }
                Button("Cancel", role: .cancel) { renaming = nil }
            }
        }
    }
}
