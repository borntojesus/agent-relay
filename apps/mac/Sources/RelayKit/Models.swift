import Foundation

// Shapes of docs/console-api.md. Dates stay strings on the wire and are parsed
// with `RelayDate.parse` where the UI needs them.

public struct OwnerInfo: Codable, Equatable {
    public let id: String
    public let name: String
    public let tz: String
}

public struct TokenInfo: Codable, Equatable {
    public let label: String
    public let read: Bool
    public let send: Bool
}

public struct Channels: Codable, Equatable {
    public let telegram: Bool
    public let console: Bool
}

public enum TeamRole: String, Codable, Equatable {
    case admin, member
}

public enum TeamGate: String, Codable, Equatable {
    case on, off
}

/// A team as `GET /owner/me` lists it.
public struct MeTeam: Codable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let role: TeamRole
}

public struct MeResponse: Codable, Equatable {
    public let owner: OwnerInfo
    public let token: TokenInfo
    public let channels: Channels
    /// Missing on a relay older than 0.4.0.
    public let teams: [MeTeam]?
    public let version: String
    /// 0.5.0: tasks awaiting tap plus pending tool approvals. Nil on older relays.
    public let pendingTasks: Int?
}

public struct TeamMember: Codable, Equatable, Identifiable, Hashable {
    public let id: String
    public let name: String
    public let role: TeamRole
}

/// A placeholder person: invited to the team, no owner and no token yet.
public struct TeamInvite: Codable, Equatable, Identifiable, Hashable {
    public let id: Int
    public let name: String
    public let note: String?
}

public struct Team: Codable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let gate: TeamGate
    /// The caller's role in this team.
    public let role: TeamRole
    public let members: [TeamMember]
    public let rooms: [String]
    public let invites: [TeamInvite]

    public init(id: String, name: String, gate: TeamGate, role: TeamRole, members: [TeamMember], rooms: [String], invites: [TeamInvite]) {
        self.id = id
        self.name = name
        self.gate = gate
        self.role = role
        self.members = members
        self.rooms = rooms
        self.invites = invites
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        gate = try c.decodeIfPresent(TeamGate.self, forKey: .gate) ?? .on
        role = try c.decodeIfPresent(TeamRole.self, forKey: .role) ?? .member
        members = try c.decodeIfPresent([TeamMember].self, forKey: .members) ?? []
        rooms = try c.decodeIfPresent([String].self, forKey: .rooms) ?? []
        invites = try c.decodeIfPresent([TeamInvite].self, forKey: .invites) ?? []
    }
}

public struct TeamsResponse: Codable {
    public let teams: [Team]
}

public struct Person: Codable, Equatable, Hashable, Identifiable {
    public let id: String
    public let name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

public struct Summary: Codable, Equatable {
    public let unread: Int
    public let unreadOwn: Int
    public let pendingPosts: Int
    public let pendingApprovals: Int
    public let feedCursor: Int
    public let auditCursor: Int
    /// Awaiting-tap tasks plus pending tool approvals (0.5.0); nil from an older relay.
    public let pendingTasks: Int?

    public init(unread: Int = 0, unreadOwn: Int = 0, pendingPosts: Int = 0, pendingApprovals: Int = 0, feedCursor: Int = 0, auditCursor: Int = 0, pendingTasks: Int? = nil) {
        self.unread = unread
        self.unreadOwn = unreadOwn
        self.pendingPosts = pendingPosts
        self.pendingApprovals = pendingApprovals
        self.feedCursor = feedCursor
        self.auditCursor = auditCursor
        self.pendingTasks = pendingTasks
    }
}

public enum MessageStatus: String, Codable {
    case pending, delivered, rejected, expired
}

public struct ConsoleMessage: Codable, Identifiable, Equatable {
    public let id: Int
    public let ver: Int
    public let room: String
    public let thread: String
    public let from: String
    public let owner: String
    public let ownerName: String
    public let mine: Bool
    public let sentAt: String
    public let text: String
    public let status: MessageStatus
    public let gated: Bool
    public let decidedAt: String?
    public let decidedBy: String?
    public let read: Bool
    // Present on thread messages only.
    public let readBy: [String]?
    // Present on pending posts only.
    public let seenBy: [String]?
    public let expiresAt: String?
}

public struct RoomMember: Codable, Equatable, Hashable {
    public let label: String
    public let owner: String
    public let read: Bool
    public let send: Bool
}

public struct Room: Codable, Identifiable, Equatable {
    public var id: String { room }
    public let room: String
    public let title: String
    public let members: [RoomMember]
    public let owners: [String]
    public let gated: Bool
    public let unread: Int
    public let unreadOwn: Int
    public let lastAt: String?
    public let threads: Int
    /// 0.4.0: the team this room belongs to, nil for a direct room (and on older relays).
    public let team: String?
    public let teamName: String?
    /// 0.4.0: the people who see the room. Nil on older relays.
    public let people: [Person]?
}

public struct RoomsResponse: Codable {
    public let rooms: [Room]
}

public struct ThreadInfo: Codable, Identifiable, Equatable {
    public var id: String { thread }
    public let thread: String
    public let messages: Int
    public let unread: Int
    public let lastAt: String
    public let lastSender: String
}

public struct ThreadsResponse: Codable {
    public let room: String
    public let threads: [ThreadInfo]
}

public struct ThreadResponse: Codable {
    public let trust: String?
    public let room: String
    public let thread: String
    public let messages: [ConsoleMessage]

    enum CodingKeys: String, CodingKey {
        case trust = "_trust"
        case room, thread, messages
    }
}

public struct FeedResponse: Codable {
    public let trust: String?
    public let messages: [ConsoleMessage]
    public let cursor: Int
    public let more: Bool

    enum CodingKeys: String, CodingKey {
        case trust = "_trust"
        case messages, cursor, more
    }
}

public enum ApprovalTier: String, Codable {
    case read, small, big
}

public enum ApprovalStatus: String, Codable {
    case pending, approved, rejected, expired
}

public struct ApprovalEffect: Codable, Equatable {
    public let diff: String?
    public let recipient: String?
    public let amount: String?
    public let details: String?
}

public struct OwnerApproval: Codable, Identifiable, Equatable {
    public let id: String
    public let scope: String
    public let project: String
    public let action: String
    public let tier: ApprovalTier
    public let summary: String
    public let effect: ApprovalEffect
    public let requester: String
    public let status: ApprovalStatus
    public let decidedVia: String?
    public let decidedBy: String?
    public let createdAt: String
    public let expiresAt: String
    public let decidedAt: String?
    public let ref: String?
    public let caller: String
}

public struct PendingResponse: Codable, Equatable {
    public let posts: [ConsoleMessage]
    public let approvals: [OwnerApproval]

    public init(posts: [ConsoleMessage] = [], approvals: [OwnerApproval] = []) {
        self.posts = posts
        self.approvals = approvals
    }
}

public enum PostOutcome: String, Codable {
    case delivered, rejected, gone
}

public struct PostDecision: Codable {
    public let outcome: PostOutcome
    public let message: ConsoleMessage?
}

public struct ApprovalsResponse: Codable {
    public let approvals: [OwnerApproval]
}

public struct AuditEntry: Codable, Identifiable, Equatable {
    public let id: Int
    public let at: String
    public let actor: String
    public let owner: String?
    public let action: String
    public let target: String?
    public let ok: Bool
    public let detail: String?
}

public struct AuditResponse: Codable {
    public let entries: [AuditEntry]
}

public struct TokenGrant: Codable, Equatable, Hashable {
    public let channel: String
    public let read: Bool
    public let send: Bool

    public var display: String {
        "\(channel):\(read ? "r" : "")\(send ? "w" : "")"
    }
}

public enum TokenKind: String, Codable {
    case agent, console, worker

    /// A kind this build does not know reads as `agent`, so a newer relay never breaks the token list.
    public init(from decoder: Decoder) throws {
        self = TokenKind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .agent
    }
}

public struct RelayToken: Codable, Identifiable, Equatable {
    public let id: Int
    public let label: String
    public let kind: TokenKind
    public let grants: [TokenGrant]
    public let rooms: [String]
    public let createdAt: String
    public let revokedAt: String?
    public let lastUsedAt: String?
    public let current: Bool
}

public struct TokensResponse: Codable {
    public let tokens: [RelayToken]
}

public enum Decision: String, Codable {
    case approve, reject
}
