import LocalAuthentication
import SwiftUI

/// Face ID / passcode lock over the whole app. Anyone holding the unlocked phone could otherwise reach every EC2
/// instance the Mac can, so it is on by default.
@MainActor
final class AppLock: ObservableObject {
    @AppStorage("lockEnabled") var enabled = true
    /// Minutes in the background before the app asks again; 0 = every time.
    @AppStorage("lockAfterMinutes") var lockAfterMinutes = 1
    @Published private(set) var locked: Bool
    @Published var error: String?
    private var backgroundedAt: Date?
    private var authenticating = false

    init() {
        locked = UserDefaults.standard.object(forKey: "lockEnabled") as? Bool ?? true
    }

    var biometryName: String {
        let ctx = LAContext()
        _ = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch ctx.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        default: return "Passcode"
        }
    }

    func didEnterBackground() {
        backgroundedAt = Date()
    }

    func willEnterForeground() {
        guard enabled, let since = backgroundedAt else { return }
        if Date().timeIntervalSince(since) >= Double(lockAfterMinutes * 60) { locked = true }
        backgroundedAt = nil
    }

    func unlock() {
        guard locked, !authenticating else { return }
        guard enabled else { locked = false; return }
        let ctx = LAContext()
        var err: NSError?
        // deviceOwnerAuthentication falls back to the passcode when Face ID fails or is not set up.
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else {
            locked = false
            return
        }
        authenticating = true
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock EC2 Remote") { ok, e in
            Task { @MainActor in
                self.authenticating = false
                if ok { self.locked = false; self.error = nil }
                else if let e = e as? LAError, e.code == .passcodeNotSet || e.code == .biometryNotEnrolled || e.code == .biometryNotAvailable {
                    // Nothing on this phone can prove who is holding it; locking would only shut its owner out.
                    self.locked = false
                } else if let e = e as? LAError, e.code != .userCancel, e.code != .appCancel, e.code != .systemCancel { self.error = e.localizedDescription }
            }
        }
    }
}

struct LockScreen: View {
    @ObservedObject var lock: AppLock

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "lock.fill").font(.system(size: 44)).foregroundStyle(.secondary)
            Text("EC2 Remote is locked").font(.title3.weight(.semibold))
            if let e = lock.error { Text(e).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center) }
            Button {
                lock.unlock()
            } label: {
                Label("Unlock with \(lock.biometryName)", systemImage: lock.biometryName == "Face ID" ? "faceid" : "lock.open")
                    .frame(maxWidth: 280)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.background)
        .onAppear { lock.unlock() }
    }
}
