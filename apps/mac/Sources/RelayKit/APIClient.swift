import Foundation

public enum RelayError: LocalizedError, Equatable {
    case badURL
    case http(status: Int, message: String)
    case transport(String)
    case decoding(String)

    public var errorDescription: String? {
        switch self {
        case .badURL: return "The server URL is not valid."
        case let .http(status, message):
            switch status {
            case 401: return "Unauthorized: wrong username or token (\(message))."
            case 403: return "Forbidden: \(message)"
            case 404: return "Not found: \(message)"
            case 409: return "Already decided: \(message)"
            default: return "HTTP \(status): \(message)"
            }
        case let .transport(m): return "Cannot reach the server: \(m)"
        case let .decoding(m): return "Unexpected response from the server: \(m)"
        }
    }

    /// The server's own reason for an HTTP error (for inline display), else the description.
    public var reason: String {
        if case let .http(_, message) = self { return message }
        return errorDescription ?? ""
    }

    public var status: Int? {
        if case let .http(s, _) = self { return s }
        return nil
    }
}

/// Owner console API client (docs/console-api.md). Never logs the token.
public struct RelayClient: Sendable {
    public let baseURL: URL
    public let owner: String
    private let token: String
    private let session: URLSession

    public init(baseURL: URL, owner: String, token: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.owner = owner
        self.token = token
        self.session = session
    }

    /// Accepts "relay.example.org" or a full URL; strips a trailing slash.
    public static func normalize(server: String) -> URL? {
        var s = server.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        if !s.contains("://") { s = "https://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        guard let url = URL(string: s), let scheme = url.scheme, ["http", "https"].contains(scheme), url.host != nil else { return nil }
        return url
    }

    // MARK: routes

    public func me() async throws -> MeResponse { try await get("/owner/me") }
    public func summary() async throws -> Summary { try await get("/owner/summary") }
    public func rooms() async throws -> RoomsResponse { try await get("/owner/rooms") }

    // MARK: teams (0.4.0; an older relay answers 404)

    public func teams() async throws -> TeamsResponse { try await get("/owner/teams") }

    /// Team admins only: rename and/or set the gate policy.
    public func updateTeam(id: String, name: String? = nil, gate: TeamGate? = nil) async throws -> Team {
        struct Body: Encodable { let name: String?; let gate: TeamGate? }
        return try await send("PATCH", "/owner/teams/\(seg(id))", body: Body(name: name, gate: gate))
    }

    public func addTeamMember(team: String, owner: String, role: TeamRole = .member) async throws -> Team {
        try await send("POST", "/owner/teams/\(seg(team))/members", body: ["owner": owner, "role": role.rawValue])
    }

    public func removeTeamMember(team: String, owner: String) async throws -> Team {
        try await send("DELETE", "/owner/teams/\(seg(team))/members/\(seg(owner))", body: Optional<String>.none)
    }

    public func addTeamInvite(team: String, name: String, note: String? = nil) async throws -> Team {
        struct Body: Encodable { let name: String; let note: String? }
        return try await send("POST", "/owner/teams/\(seg(team))/invites", body: Body(name: name, note: note))
    }

    public func removeTeamInvite(team: String, invite: Int) async throws -> Team {
        try await send("DELETE", "/owner/teams/\(seg(team))/invites/\(invite)", body: Optional<String>.none)
    }

    public func threads(room: String) async throws -> ThreadsResponse {
        try await get("/owner/rooms/\(seg(room))/threads")
    }

    public func thread(room: String, thread: String, before: Int? = nil, limit: Int? = nil) async throws -> ThreadResponse {
        var q: [URLQueryItem] = []
        if let before { q.append(.init(name: "before", value: String(before))) }
        if let limit { q.append(.init(name: "limit", value: String(limit))) }
        return try await get("/owner/rooms/\(seg(room))/threads/\(seg(thread))", query: q)
    }

    public func ack(room: String, thread: String?) async throws {
        struct Body: Encodable { let thread: String? ; let all: Bool? }
        let body = thread != nil ? Body(thread: thread, all: nil) : Body(thread: nil, all: true)
        let _: Empty = try await send("POST", "/owner/rooms/\(seg(room))/ack", body: body)
    }

    public func feed(after: Int, limit: Int = 100) async throws -> FeedResponse {
        try await get("/owner/feed", query: [.init(name: "after", value: String(after)), .init(name: "limit", value: String(limit))])
    }

    public func pending() async throws -> PendingResponse { try await get("/owner/pending") }

    public func decidePost(id: Int, _ decision: Decision) async throws -> PostDecision {
        try await send("POST", "/owner/posts/\(id)/decide", body: ["decision": decision.rawValue])
    }

    public func approvals(status: String? = nil, limit: Int? = nil) async throws -> ApprovalsResponse {
        var q: [URLQueryItem] = []
        if let status { q.append(.init(name: "status", value: status)) }
        if let limit { q.append(.init(name: "limit", value: String(limit))) }
        return try await get("/owner/approvals", query: q)
    }

    public func decideApproval(id: String, _ decision: Decision) async throws -> OwnerApproval {
        try await send("POST", "/owner/approvals/\(seg(id))/decide", body: ["decision": decision.rawValue])
    }

    public func audit(before: Int? = nil, limit: Int = 100) async throws -> AuditResponse {
        var q: [URLQueryItem] = [.init(name: "limit", value: String(limit))]
        if let before { q.append(.init(name: "before", value: String(before))) }
        return try await get("/owner/audit", query: q)
    }

    public func tokens(all: Bool = true) async throws -> TokensResponse {
        try await get("/owner/tokens", query: all ? [.init(name: "all", value: "1")] : [])
    }

    public func revoke(label: String) async throws {
        let _: Empty = try await send("POST", "/owner/tokens/\(seg(label))/revoke", body: [String: String]())
    }

    // MARK: plumbing

    struct Empty: Decodable {}
    private struct ErrorBody: Decodable { let error: String? }

    private static let segmentAllowed: CharacterSet = {
        var cs = CharacterSet.urlPathAllowed
        cs.remove(charactersIn: "/?#%")
        return cs
    }()

    func seg(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: Self.segmentAllowed) ?? s
    }

    private func request(_ method: String, _ path: String, query: [URLQueryItem]) throws -> URLRequest {
        guard var comps = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { throw RelayError.badURL }
        // `path` is already percent-encoded per segment.
        comps.percentEncodedPath = (comps.percentEncodedPath.hasSuffix("/") ? String(comps.percentEncodedPath.dropLast()) : comps.percentEncodedPath) + path
        comps.queryItems = query.isEmpty ? nil : query
        guard let url = comps.url else { throw RelayError.badURL }
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue(owner, forHTTPHeaderField: "X-Relay-Owner")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.cachePolicy = .reloadIgnoringLocalCacheData
        return req
    }

    func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        try await perform(try request("GET", path, query: query))
    }

    func send<T: Decodable, B: Encodable>(_ method: String, _ path: String, body: B) async throws -> T {
        var req = try request(method, path, query: [])
        // `Optional.none` as the body sends no body (DELETE).
        if let opt = body as? OptionalBody, opt.isNone { return try await perform(req) }
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        return try await perform(req)
    }

    private func perform<T: Decodable>(_ req: URLRequest) async throws -> T {
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await session.data(for: req)
        } catch {
            throw RelayError.transport(error.localizedDescription)
        }
        guard let http = resp as? HTTPURLResponse else { throw RelayError.transport("no HTTP response") }
        guard (200..<300).contains(http.statusCode) else {
            let msg = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
                ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            throw RelayError.http(status: http.statusCode, message: msg)
        }
        if T.self == Empty.self { return Empty() as! T }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw RelayError.decoding(String(describing: error))
        }
    }
}

private protocol OptionalBody { var isNone: Bool { get } }
extension Optional: OptionalBody { var isNone: Bool { self == nil } }

public enum RelayDate {
    private static let frac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    public static func parse(_ s: String?) -> Date? {
        guard let s else { return nil }
        return frac.date(from: s) ?? plain.date(from: s)
    }
}
