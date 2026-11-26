import Foundation

// 0.5.0: tasks between own machines (console side). Decoded defensively: every
// field the UI can live without is optional or has a default, so a relay that
// adds or drops a field does not break the app.

/// Any JSON value (task event `data`, tool input).
public enum JSONValue: Codable, Equatable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
        else { self = .null }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case let .string(s): try c.encode(s)
        case let .number(n): try c.encode(n)
        case let .bool(b): try c.encode(b)
        case let .object(o): try c.encode(o)
        case let .array(a): try c.encode(a)
        case .null: try c.encodeNil()
        }
    }

    public subscript(key: String) -> JSONValue? {
        if case let .object(o) = self { return o[key] }
        return nil
    }

    public var string: String? {
        switch self {
        case let .string(s): return s
        case let .number(n): return n == n.rounded() && abs(n) < 1e15 ? String(Int(n)) : String(n)
        case let .bool(b): return b ? "true" : "false"
        default: return nil
        }
    }

    public var number: Double? {
        switch self {
        case let .number(n): return n
        case let .string(s): return Double(s)
        default: return nil
        }
    }

    public var bool: Bool? { if case let .bool(b) = self { return b }; return nil }

    public var strings: [String] {
        switch self {
        case let .array(a): return a.compactMap(\.string)
        case let .string(s): return s.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        default: return []
        }
    }

    /// Compact one-line rendering for display (tool input and the like).
    public var compact: String {
        switch self {
        case let .string(s): return s
        case .null: return ""
        default:
            let enc = JSONEncoder()
            enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            return (try? String(data: enc.encode(self), encoding: .utf8)) ?? ""
        }
    }
}

public enum TaskStatus: String, Codable, CaseIterable, Hashable {
    case queued
    case awaitingTap = "awaiting_tap"
    case accepted
    case running
    case waitingApproval = "waiting_approval"
    case done
    case failed
    case cancelled

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        // An unknown status from a newer relay reads as queued (non-terminal, no buttons that act).
        self = TaskStatus(rawValue: raw) ?? .queued
    }

    public var terminal: Bool { self == .done || self == .failed || self == .cancelled }
}

public enum TaskPriority: String, Codable, CaseIterable, Hashable {
    case low, normal, high

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = TaskPriority(rawValue: raw) ?? .normal
    }
}

public enum PermissionMode: String, Codable, CaseIterable, Hashable {
    case `default`, acceptEdits, plan

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PermissionMode(rawValue: raw) ?? .default
    }
}

/// Tool-call categories that can require a tool approval.
public enum ApprovalAction: String, Codable, CaseIterable, Hashable {
    case push, deploy, delete, prod
}

/// Per-machine policy (the server validates it and is the source of truth).
public struct MachinePolicy: Codable, Equatable, Hashable {
    public var folders: [String]
    public var permissionMode: PermissionMode
    public var allowedTools: [String]
    public var disallowedTools: [String]
    public var requireTap: Bool
    public var approvalActions: [String]
    public var maxRuntimeMinutes: Int
    public var allowFollowUps: Bool

    /// The strict default of a new machine.
    public static let strict = MachinePolicy(
        folders: [], permissionMode: .default, allowedTools: ["Read", "Glob", "Grep"], disallowedTools: [],
        requireTap: true, approvalActions: ApprovalAction.allCases.map(\.rawValue), maxRuntimeMinutes: 30, allowFollowUps: true)

    public init(folders: [String], permissionMode: PermissionMode, allowedTools: [String], disallowedTools: [String],
                requireTap: Bool, approvalActions: [String], maxRuntimeMinutes: Int, allowFollowUps: Bool) {
        self.folders = folders
        self.permissionMode = permissionMode
        self.allowedTools = allowedTools
        self.disallowedTools = disallowedTools
        self.requireTap = requireTap
        self.approvalActions = approvalActions
        self.maxRuntimeMinutes = maxRuntimeMinutes
        self.allowFollowUps = allowFollowUps
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = MachinePolicy.strict
        folders = try c.decodeIfPresent([String].self, forKey: .folders) ?? d.folders
        permissionMode = try c.decodeIfPresent(PermissionMode.self, forKey: .permissionMode) ?? d.permissionMode
        allowedTools = try c.decodeIfPresent([String].self, forKey: .allowedTools) ?? d.allowedTools
        disallowedTools = try c.decodeIfPresent([String].self, forKey: .disallowedTools) ?? d.disallowedTools
        requireTap = try c.decodeIfPresent(Bool.self, forKey: .requireTap) ?? d.requireTap
        approvalActions = try c.decodeIfPresent([String].self, forKey: .approvalActions) ?? d.approvalActions
        maxRuntimeMinutes = try c.decodeIfPresent(Int.self, forKey: .maxRuntimeMinutes) ?? d.maxRuntimeMinutes
        allowFollowUps = try c.decodeIfPresent(Bool.self, forKey: .allowFollowUps) ?? d.allowFollowUps
    }
}

public struct Machine: Codable, Equatable, Identifiable, Hashable {
    public let id: String
    public let name: String
    public let online: Bool
    public let lastSeen: String?
    public let killed: Bool
    public let workerVersion: String?
    public let policy: MachinePolicy
    public let running: Int
    public let queued: Int

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? id
        online = try c.decodeIfPresent(Bool.self, forKey: .online) ?? false
        lastSeen = try c.decodeIfPresent(String.self, forKey: .lastSeen)
        killed = try c.decodeIfPresent(Bool.self, forKey: .killed) ?? false
        workerVersion = try c.decodeIfPresent(String.self, forKey: .workerVersion)
        policy = try c.decodeIfPresent(MachinePolicy.self, forKey: .policy) ?? .strict
        running = try c.decodeIfPresent(Int.self, forKey: .running) ?? 0
        queued = try c.decodeIfPresent(Int.self, forKey: .queued) ?? 0
    }

    /// `PATCH` answers with the machine, possibly wrapped as `{ machine }`.
    struct Envelope: Decodable {
        let value: Machine
        enum K: String, CodingKey { case machine }
        init(from decoder: Decoder) throws {
            if let c = try? decoder.container(keyedBy: K.self), let m = try? c.decode(Machine.self, forKey: .machine) {
                value = m
            } else {
                value = try Machine(from: decoder)
            }
        }
    }
}

public struct MachinesResponse: Codable {
    public let machines: [Machine]
}

/// A tool call waiting for the owner (the worker's PreToolUse hook blocks on it).
public struct ToolApproval: Codable, Equatable, Identifiable, Hashable {
    public let id: String
    public let task: String
    public let machine: String?
    public let tool: String
    public let summary: String
    /// One or more categories (push, deploy, delete, prod). The server may send a string or a list.
    public let categories: [String]
    public let status: ApprovalStatus
    public let createdAt: String?
    public let decidedAt: String?
    public let decidedBy: String?
    public let expiresAt: String?

    enum CodingKeys: String, CodingKey {
        case id, task, machine, tool, summary, category, status, createdAt, decidedAt, decidedBy, expiresAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        task = try c.decodeIfPresent(String.self, forKey: .task) ?? ""
        machine = try c.decodeIfPresent(String.self, forKey: .machine)
        tool = try c.decodeIfPresent(String.self, forKey: .tool) ?? "tool"
        summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
        categories = (try c.decodeIfPresent(JSONValue.self, forKey: .category))?.strings ?? []
        status = (try? c.decodeIfPresent(ApprovalStatus.self, forKey: .status)) ?? .pending
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        decidedAt = try c.decodeIfPresent(String.self, forKey: .decidedAt)
        decidedBy = try c.decodeIfPresent(String.self, forKey: .decidedBy)
        expiresAt = try c.decodeIfPresent(String.self, forKey: .expiresAt)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(task, forKey: .task)
        try c.encodeIfPresent(machine, forKey: .machine)
        try c.encode(tool, forKey: .tool)
        try c.encode(summary, forKey: .summary)
        try c.encode(categories, forKey: .category)
        try c.encode(status, forKey: .status)
        try c.encodeIfPresent(createdAt, forKey: .createdAt)
        try c.encodeIfPresent(decidedAt, forKey: .decidedAt)
        try c.encodeIfPresent(decidedBy, forKey: .decidedBy)
        try c.encodeIfPresent(expiresAt, forKey: .expiresAt)
    }
}

/// A task (named RelayTask so it never shadows Swift's `Task`).
public struct RelayTask: Codable, Equatable, Identifiable, Hashable {
    public let id: String
    public let machine: String
    public let machineName: String?
    public let folder: String
    public let prompt: String
    public let priority: TaskPriority
    public let status: TaskStatus
    public let createdBy: String?
    public let sourceMachine: String?
    public let createdAt: String?
    public let updatedAt: String?
    public let startedAt: String?
    public let finishedAt: String?
    public let result: String?
    public let exitCode: Int?
    public let error: String?
    public let sessionId: String?
    public let parent: String?
    public let cancelRequested: Bool
    public let pendingApprovals: [ToolApproval]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        machine = try c.decodeIfPresent(String.self, forKey: .machine) ?? ""
        machineName = try c.decodeIfPresent(String.self, forKey: .machineName)
        folder = try c.decodeIfPresent(String.self, forKey: .folder) ?? ""
        prompt = try c.decodeIfPresent(String.self, forKey: .prompt) ?? ""
        priority = try c.decodeIfPresent(TaskPriority.self, forKey: .priority) ?? .normal
        status = try c.decodeIfPresent(TaskStatus.self, forKey: .status) ?? .queued
        createdBy = try c.decodeIfPresent(String.self, forKey: .createdBy)
        sourceMachine = try c.decodeIfPresent(String.self, forKey: .sourceMachine)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
        startedAt = try c.decodeIfPresent(String.self, forKey: .startedAt)
        finishedAt = try c.decodeIfPresent(String.self, forKey: .finishedAt)
        result = try c.decodeIfPresent(String.self, forKey: .result)
        exitCode = try c.decodeIfPresent(Int.self, forKey: .exitCode)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
        parent = try c.decodeIfPresent(String.self, forKey: .parent)
        // SQLite booleans may arrive as 0/1.
        if let b = try? c.decodeIfPresent(Bool.self, forKey: .cancelRequested) {
            cancelRequested = b
        } else {
            cancelRequested = ((try? c.decodeIfPresent(Int.self, forKey: .cancelRequested)) ?? 0) != 0
        }
        pendingApprovals = (try? c.decodeIfPresent([ToolApproval].self, forKey: .pendingApprovals)) ?? []
    }

    public var displayMachine: String { machineName?.nilIfBlank ?? machine }

    /// First non-empty line of the prompt.
    public var title: String {
        prompt.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? "(empty prompt)"
    }

    /// `POST` answers with the task, possibly wrapped as `{ task }`.
    struct Envelope: Decodable {
        let value: RelayTask
        enum K: String, CodingKey { case task }
        init(from decoder: Decoder) throws {
            if let c = try? decoder.container(keyedBy: K.self), let t = try? c.decode(RelayTask.self, forKey: .task) {
                value = t
            } else {
                value = try RelayTask(from: decoder)
            }
        }
    }
}

public struct TasksResponse: Codable {
    public let tasks: [RelayTask]
}

/// One append-only task event (`task_events`).
public struct TaskEvent: Codable, Equatable, Identifiable, Hashable {
    public let id: Int
    public let task: String?
    public let at: String
    public let actor: String
    public let machine: String?
    public let type: String
    public let data: JSONValue?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        task = try c.decodeIfPresent(String.self, forKey: .task)
        at = try c.decodeIfPresent(String.self, forKey: .at) ?? ""
        actor = try c.decodeIfPresent(String.self, forKey: .actor) ?? "server"
        machine = try c.decodeIfPresent(String.self, forKey: .machine)
        type = try c.decodeIfPresent(String.self, forKey: .type) ?? "log"
        // `data` may be an object or a JSON string holding one.
        let raw = try c.decodeIfPresent(JSONValue.self, forKey: .data)
        if case let .string(s)? = raw, let d = s.data(using: .utf8), let parsed = try? JSONDecoder().decode(JSONValue.self, from: d),
           case .object = parsed {
            data = parsed
        } else {
            data = raw
        }
    }
}

public struct TaskEventsResponse: Codable {
    public let events: [TaskEvent]
}

extension String {
    var nilIfBlank: String? { trimmingCharacters(in: .whitespaces).isEmpty ? nil : self }
}

// MARK: routes

public extension RelayClient {
    func machines() async throws -> MachinesResponse { try await get("/owner/machines") }

    /// Any of name, policy, killed; nil fields are left out of the body.
    func updateMachine(id: String, name: String? = nil, policy: MachinePolicy? = nil, killed: Bool? = nil) async throws -> Machine {
        struct Body: Encodable { let name: String?; let policy: MachinePolicy?; let killed: Bool? }
        let e: Machine.Envelope = try await send("PATCH", "/owner/machines/\(seg(id))", body: Body(name: name, policy: policy, killed: killed))
        return e.value
    }

    func tasks(machine: String? = nil, status: TaskStatus? = nil, limit: Int? = nil) async throws -> TasksResponse {
        var q: [URLQueryItem] = []
        if let machine { q.append(.init(name: "machine", value: machine)) }
        if let status { q.append(.init(name: "status", value: status.rawValue)) }
        if let limit { q.append(.init(name: "limit", value: String(limit))) }
        return try await get("/owner/tasks", query: q)
    }

    func createTask(machine: String, folder: String, prompt: String, priority: TaskPriority = .normal, sourceMachine: String? = nil) async throws -> RelayTask {
        struct Body: Encodable { let machine: String; let folder: String; let prompt: String; let priority: TaskPriority; let sourceMachine: String? }
        let e: RelayTask.Envelope = try await send("POST", "/owner/tasks",
                                                    body: Body(machine: machine, folder: folder, prompt: prompt, priority: priority, sourceMachine: sourceMachine))
        return e.value
    }

    /// One task with its pending approvals (the open detail polls this).
    func task(id: String) async throws -> RelayTask {
        let e: RelayTask.Envelope = try await get("/owner/tasks/\(seg(id))")
        return e.value
    }

    /// Answers with the task.
    @discardableResult
    func startTask(id: String) async throws -> RelayTask {
        let e: RelayTask.Envelope = try await send("POST", "/owner/tasks/\(seg(id))/start", body: [String: String]())
        return e.value
    }

    /// Answers with the task (`cancelRequested` set while a worker still runs it).
    @discardableResult
    func cancelTask(id: String) async throws -> RelayTask {
        let e: RelayTask.Envelope = try await send("POST", "/owner/tasks/\(seg(id))/cancel", body: [String: String]())
        return e.value
    }

    func followUp(task id: String, prompt: String) async throws -> RelayTask {
        let e: RelayTask.Envelope = try await send("POST", "/owner/tasks/\(seg(id))/followup", body: ["prompt": prompt])
        return e.value
    }

    func taskEvents(id: String, after: Int? = nil) async throws -> TaskEventsResponse {
        try await get("/owner/tasks/\(seg(id))/events", query: after.map { [.init(name: "after", value: String($0))] } ?? [])
    }

    /// Answers `{ approval, task }`; returns the task.
    @discardableResult
    func decideToolApproval(task: String, approval: String, _ decision: Decision) async throws -> RelayTask {
        let e: RelayTask.Envelope = try await send("POST", "/owner/tasks/\(seg(task))/approvals/\(seg(approval))", body: ["decision": decision.rawValue])
        return e.value
    }

    func taskLog(machine: String? = nil, task: String? = nil, limit: Int = 100, before: Int? = nil) async throws -> TaskEventsResponse {
        var q: [URLQueryItem] = [.init(name: "limit", value: String(limit))]
        if let machine { q.append(.init(name: "machine", value: machine)) }
        if let task { q.append(.init(name: "task", value: task)) }
        if let before { q.append(.init(name: "before", value: String(before))) }
        return try await get("/owner/task-log", query: q)
    }
}
