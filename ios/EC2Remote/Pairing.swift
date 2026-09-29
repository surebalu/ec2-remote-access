import Foundation
import Security

/// A computer running EC2 Remote Access (the Mac app's Phone access, or the standalone gateway).
struct Gateway: Codable, Identifiable, Hashable {
    var id = UUID()
    /// Shown in the app; defaults to the first label of the host name ("surendras-macbook-pro").
    var name: String
    /// Scheme, host and port only, e.g. https://my-mac.tail1234.ts.net
    var baseURL: URL
    var token: String

    /// The page the web view opens. `layout=mobile` keeps the touch layout on every screen size (an unfolded
    /// foldable is wider than the width at which the browser version would switch to the desktop layout).
    var appURL: URL {
        var c = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        c.path = "/"
        c.queryItems = [URLQueryItem(name: "layout", value: "mobile"), URLQueryItem(name: "app", value: "ios")]
        c.fragment = "token=\(token)"
        return c.url!
    }

    var displayHost: String { baseURL.host ?? baseURL.absoluteString }
}

enum PairingError: LocalizedError {
    case notALink, noToken, rejected, unreachable(String)

    var errorDescription: String? {
        switch self {
        case .notALink: "That isn't an EC2 Remote Access link. In the Mac app open Settings → Phone access and scan the QR code shown there."
        case .noToken: "The link has no access token. Copy it again with Copy link in Settings → Phone access."
        case .rejected: "The computer rejected this token. It may have been rotated; scan the current QR code."
        case .unreachable(let why): "Couldn't reach the computer (\(why)). Check that EC2 Remote Access is running, the Mac is awake, and Tailscale is connected on both devices."
        }
    }
}

enum Pairing {
    /// Parses the pairing link from the QR code / Copy link: `https://host[:port]/#token=…`.
    static func parse(_ text: String) throws -> Gateway {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http", let host = url.host, !host.isEmpty else {
            throw PairingError.notALink
        }
        let fragment = url.fragment ?? ""
        let token = fragment.split(separator: "&").compactMap { part -> String? in
            let kv = part.split(separator: "=", maxSplits: 1)
            return kv.count == 2 && kv[0] == "token" ? String(kv[1]).removingPercentEncoding : nil
        }.first
        guard let token, !token.isEmpty else { throw PairingError.noToken }
        var base = URLComponents()
        base.scheme = scheme
        base.host = host
        base.port = url.port
        let name = host.split(separator: ".").first.map(String.init) ?? host
        return Gateway(name: name, baseURL: base.url!, token: token)
    }

    /// Asks the gateway whether the token is valid (GET /auth answers 204, or 401 for a wrong token).
    static func verify(_ g: Gateway) async throws {
        var c = URLComponents(url: g.baseURL, resolvingAgainstBaseURL: false)!
        c.path = "/auth"
        c.queryItems = [URLQueryItem(name: "token", value: g.token)]
        var req = URLRequest(url: c.url!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        req.httpMethod = "GET"
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            if (resp as? HTTPURLResponse)?.statusCode == 401 { throw PairingError.rejected }
        } catch let e as PairingError {
            throw e
        } catch {
            throw PairingError.unreachable(error.localizedDescription)
        }
    }
}

/// Paired computers, stored in the Keychain (the token is as powerful as the Mac app itself).
@MainActor
final class GatewayStore: ObservableObject {
    @Published private(set) var gateways: [Gateway] = []
    @Published var selectedID: UUID? {
        didSet { UserDefaults.standard.set(selectedID?.uuidString, forKey: "selectedGateway") }
    }

    var selected: Gateway? { gateways.first { $0.id == selectedID } ?? gateways.first }

    init() {
        gateways = Keychain.load()
        selectedID = UserDefaults.standard.string(forKey: "selectedGateway").flatMap(UUID.init(uuidString:))
    }

    /// Adds or replaces (same host) a computer and makes it the current one.
    func add(_ g: Gateway) {
        var g = g
        if let i = gateways.firstIndex(where: { $0.baseURL == g.baseURL }) {
            g.id = gateways[i].id
            g.name = gateways[i].name
            gateways[i] = g
        } else {
            gateways.append(g)
        }
        selectedID = g.id
        Keychain.save(gateways)
    }

    func rename(_ id: UUID, to name: String) {
        guard let i = gateways.firstIndex(where: { $0.id == id }), !name.isEmpty else { return }
        gateways[i].name = name
        Keychain.save(gateways)
    }

    func remove(_ id: UUID) {
        gateways.removeAll { $0.id == id }
        if selectedID == id { selectedID = gateways.first?.id }
        Keychain.save(gateways)
    }
}

enum Keychain {
    private static let service = "EC2Remote.gateways"

    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "paired"]
    }

    static func load() -> [Gateway] {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return [] }
        return (try? JSONDecoder().decode([Gateway].self, from: data)) ?? []
    }

    static func save(_ gateways: [Gateway]) {
        let data = (try? JSONEncoder().encode(gateways)) ?? Data()
        SecItemDelete(query as CFDictionary)
        var q = query
        q[kSecValueData as String] = data
        // Readable only on this device and only after the first unlock; never synced to iCloud or other devices.
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }
}
