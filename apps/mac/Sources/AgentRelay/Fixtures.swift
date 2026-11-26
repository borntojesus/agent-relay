import Foundation
import RelayKit

/// Fixture data for AGENT_RELAY_SNAPSHOT_FIXTURES=1 (docs screenshots without a server).
/// Built by decoding JSON, the same path real responses take. Neutral names only.
enum Fixtures {
    static let now = Date()

    static func iso(_ minutesAgo: Double) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: now.addingTimeInterval(-minutesAgo * 60))
    }

    private static func decode<T: Decodable>(_ type: T.Type, _ obj: Any) -> T {
        let data = try! JSONSerialization.data(withJSONObject: obj)
        return try! JSONDecoder().decode(T.self, from: data)
    }

    static var me: MeResponse {
        decode(MeResponse.self, [
            "owner": ["id": "alice", "name": "Alice", "tz": "Europe/Berlin"],
            "token": ["label": "console", "read": true, "send": true],
            "channels": ["telegram": true, "console": true],
            "teams": [],
            "version": "0.5.0",
            "pendingTasks": 2,
        ])
    }

    static let codePolicy: [String: Any] = [
        "folders": ["/Users/alice/code/web-app", "/Users/alice/code/shared"],
        "permissionMode": "acceptEdits",
        "allowedTools": ["Read", "Edit", "Bash(pnpm test:*)", "Bash(git status)"],
        "disallowedTools": ["Bash(rm -rf:*)", "WebFetch"],
        "requireTap": false,
        "approvalActions": ["push", "deploy", "prod"],
        "maxRuntimeMinutes": 60,
        "allowFollowUps": true,
    ]

    static var machines: [Machine] {
        decode([Machine].self, [
            ["id": "studio", "name": "studio", "online": true, "lastSeen": iso(0.1), "killed": false,
             "workerVersion": "0.5.0", "policy": codePolicy, "running": 1, "queued": 1],
            ["id": "laptop", "name": "laptop", "online": true, "lastSeen": iso(0.2), "killed": false,
             "workerVersion": "0.5.0", "running": 1, "queued": 0,
             "policy": codePolicy.merging(["requireTap": true, "permissionMode": "default",
                                           "folders": ["/Users/alice/code"]]) { $1 }],
            ["id": "build-box", "name": "build-box", "online": false, "lastSeen": iso(190), "killed": true,
             "workerVersion": "0.4.9", "running": 0, "queued": 0,
             "policy": codePolicy.merging(["folders": ["/home/alice/builds"], "allowFollowUps": false,
                                           "maxRuntimeMinutes": 30]) { $1 }],
        ])
    }

    private static func task(_ id: String, _ machine: String, _ folder: String, _ prompt: String, _ status: String,
                             created: Double, started: Double? = nil, finished: Double? = nil, priority: String = "normal",
                             result: String? = nil, exitCode: Int? = nil, error: String? = nil, parent: String? = nil,
                             approvals: [[String: Any]] = []) -> [String: Any] {
        var t: [String: Any] = [
            "id": id, "machine": machine, "machineName": machine, "folder": folder, "prompt": prompt,
            "priority": priority, "status": status, "createdBy": "console", "sourceMachine": "laptop",
            "createdAt": iso(created), "updatedAt": iso(finished ?? started ?? created),
            "cancelRequested": false, "pendingApprovals": approvals,
        ]
        if let started { t["startedAt"] = iso(started); t["sessionId"] = "sess-\(id)" }
        if let finished { t["finishedAt"] = iso(finished) }
        if let result { t["result"] = result }
        if let exitCode { t["exitCode"] = exitCode }
        if let error { t["error"] = error }
        if let parent { t["parent"] = parent }
        return t
    }

    static var tasks: [RelayTask] {
        decode([RelayTask].self, [
            task("t-1042", "studio", "/Users/alice/code/web-app",
                 "Ship the search page fix to the preview branch\nPush it and tell me the preview URL.",
                 "waiting_approval", created: 6, started: 5, priority: "high", approvals: [[
                     "id": "ta-77", "task": "t-1042", "machine": "studio", "tool": "Bash",
                     "summary": "git push origin fix/search-empty-state", "category": ["push"],
                     "status": "pending", "createdAt": iso(0.5), "expiresAt": iso(-9.5),
                 ]]),
            task("t-1041", "laptop", "/Users/alice/code/web-app",
                 "Run the unit tests and fix what fails", "running", created: 12, started: 11),
            task("t-1040", "laptop", "/Users/alice/code/shared",
                 "Update the shared lint config to the new rule set", "awaiting_tap", created: 15),
            task("t-1039", "studio", "/Users/alice/code/web-app",
                 "Add an index on orders.created_at and check the slow query", "queued", created: 18, priority: "low"),
            task("t-1038", "studio", "/Users/alice/code/shared",
                 "List the open TODOs in shared and group them by package",
                 "done", created: 70, started: 69, finished: 64,
                 result: """
                 12 TODOs in 4 packages:

                 shared/http      4  retry on 429, timeout config, two doc comments
                 shared/db        3  migration rollback, index on created_at, pool size
                 shared/ui        3  dark mode tokens, focus ring, table empty state
                 shared/scripts   2  release notes, version bump check

                 The db ones block the orders work; I would start there.
                 """, exitCode: 0),
            task("t-1037", "laptop", "/Users/alice/code/web-app",
                 "Bump the router to the latest minor and run the build", "failed",
                 created: 140, started: 139, finished: 131, result: "Build failed: 2 type errors in routes/settings.tsx.",
                 exitCode: 1),
            task("t-1036", "build-box", "/home/alice/builds/web-app",
                 "Rebuild the docs image", "cancelled", created: 200, started: 199, finished: 192),
            task("t-1035", "studio", "/Users/alice/code/shared",
                 "Now open a draft PR with the TODO list as the description", "done",
                 created: 62, started: 61, finished: 58, result: "Draft PR opened: shared#214.", exitCode: 0, parent: "t-1038"),
        ])
    }

    private static func ev(_ id: Int, _ task: String, _ minutesAgo: Double, _ actor: String, _ type: String,
                           _ data: [String: Any] = [:]) -> [String: Any] {
        ["id": id, "task": task, "at": iso(minutesAgo), "actor": actor, "machine": "studio", "type": type, "data": data]
    }

    static func events(for id: String) -> [TaskEvent] {
        let list: [[String: Any]]
        switch id {
        case "t-1042":
            list = [
                ev(1, id, 6, "console", "created", ["priority": "high"]),
                ev(2, id, 5.5, "studio-worker", "accepted"),
                ev(3, id, 5, "studio-worker", "started", ["pid": "48211", "claudeVersion": "2.3.1", "cwd": "/Users/alice/code/web-app"]),
                ev(4, id, 4.5, "studio-worker", "progress", ["text": "Reading the search page and its test."]),
                ev(5, id, 4, "studio-worker", "tool", ["name": "Edit", "input": ["file_path": "src/pages/search.tsx"], "category": []]),
                ev(6, id, 3, "studio-worker", "tool", ["name": "Bash", "input": ["command": "pnpm test search"], "category": []]),
                ev(7, id, 2, "studio-worker", "tool_result", ["name": "Bash", "ok": true]),
                ev(8, id, 0.5, "studio-worker", "approval_requested", ["summary": "git push origin fix/search-empty-state"]),
            ]
        case "t-1038":
            list = [
                ev(101, id, 70, "console", "created"),
                ev(102, id, 69.5, "studio-worker", "accepted"),
                ev(103, id, 69, "studio-worker", "started", ["pid": "47102", "claudeVersion": "2.3.1"]),
                ev(104, id, 68, "studio-worker", "tool", ["name": "Grep", "input": ["pattern": "TODO"], "category": []]),
                ev(105, id, 67, "studio-worker", "progress", ["text": "Found 12 TODOs. Grouping them by package."]),
                ev(106, id, 64, "studio-worker", "finished", ["exitCode": 0, "durationMs": 301_000, "numTurns": 7, "costUsd": 0.18]),
            ]
        default:
            list = [ev(1, id, 10, "console", "created")]
        }
        return decode([TaskEvent].self, list)
    }

    static func taskLog() -> [TaskEvent] {
        (events(for: "t-1042") + events(for: "t-1038")).sorted { $0.at > $1.at }
    }
}
