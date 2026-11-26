import Foundation
import Security

/// The console token lives only here: generic password, service
/// "org.antonyuk.agent-relay", account "<username>@<host>".
public enum Keychain {
    public static let service = "org.antonyuk.agent-relay"

    public static func account(owner: String, server: URL) -> String {
        var host = server.host ?? server.absoluteString
        if let port = server.port { host += ":\(port)" }
        return "\(owner)@\(host)"
    }

    private static func base(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    @discardableResult
    public static func save(token: String, account: String) -> Bool {
        let data = Data(token.utf8)
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(base(account) as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return true }
        var add = base(account)
        add[kSecValueData as String] = data
        add[kSecAttrLabel as String] = "agent-relay console token"
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    public static func load(account: String) -> String? {
        var q = base(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public static func delete(account: String) {
        SecItemDelete(base(account) as CFDictionary)
    }
}
