import AppKit
import RelayKit
import UserNotifications

/// Native notifications. Only works inside a bundled .app (UNUserNotificationCenter
/// needs a bundle id), so it is a no-op under `swift run`.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()

    private var available: Bool { Bundle.main.bundleIdentifier != nil && Bundle.main.bundlePath.hasSuffix(".app") }
    private var center: UNUserNotificationCenter? { available ? .current() : nil }

    func setUp() {
        guard let center else { return }
        center.delegate = self
        let send = UNNotificationAction(identifier: "post.send", title: "Send", options: [])
        let rejectPost = UNNotificationAction(identifier: "post.reject", title: "Reject", options: [.destructive])
        let approve = UNNotificationAction(identifier: "approval.approve", title: "Approve", options: [])
        let rejectApproval = UNNotificationAction(identifier: "approval.reject", title: "Reject", options: [.destructive])
        // Big-tier and tool approvals need the Mac unlocked (Touch ID or password) to approve from a banner.
        let approveLocked = UNNotificationAction(identifier: "approval.approve", title: "Approve", options: [.authenticationRequired])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "post", actions: [send, rejectPost], intentIdentifiers: []),
            UNNotificationCategory(identifier: "approval", actions: [approve, rejectApproval], intentIdentifiers: []),
            UNNotificationCategory(identifier: "message", actions: [], intentIdentifiers: []),
            UNNotificationCategory(identifier: "approval-big", actions: [approveLocked, rejectApproval], intentIdentifiers: []),
            UNNotificationCategory(identifier: "tool", actions: [approveLocked, rejectApproval], intentIdentifiers: []),
            UNNotificationCategory(identifier: "tap",
                                   actions: [UNNotificationAction(identifier: "task.start", title: "Start", options: [])],
                                   intentIdentifiers: []),
            UNNotificationCategory(identifier: "task", actions: [], intentIdentifiers: []),
        ])
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    private static func clip(_ s: String, _ n: Int = 120) -> String {
        let flat = s.replacingOccurrences(of: "\n", with: " ")
        return flat.count > n ? String(flat.prefix(n - 1)) + "…" : flat
    }

    func heldPost(_ m: ConsoleMessage, enabled: Bool) {
        post(id: "post-\(m.id)", category: "post",
             title: "Held post: \(m.room) / \(m.thread)",
             subtitle: "\(m.from) waits for Send",
             body: Self.clip(m.text),
             info: ["kind": "post", "id": m.id, "room": m.room, "thread": m.thread], enabled: enabled)
    }

    func approval(_ a: OwnerApproval, enabled: Bool) {
        post(id: "approval-\(a.id)", category: a.tier == .big ? "approval-big" : "approval",
             title: "Approval: \(a.action) (\(a.tier.rawValue))",
             subtitle: "\(a.project), asked by \(a.requester)",
             body: Self.clip(a.summary),
             info: ["kind": "approval", "id": a.id], enabled: enabled)
    }

    func message(_ m: ConsoleMessage, enabled: Bool) {
        post(id: "msg-\(m.id)", category: "message",
             title: "\(m.room) / \(m.thread)",
             subtitle: "\(m.from) (\(m.ownerName))",
             body: Self.clip(m.text),
             info: ["kind": "message", "room": m.room, "thread": m.thread], enabled: enabled)
    }

    func taskFinished(_ t: RelayTask, enabled: Bool) {
        let what: String
        switch t.status {
        case .done: what = "Done"
        case .failed: what = "Failed"
        default: what = "Cancelled"
        }
        post(id: "task-\(t.id)-\(t.status.rawValue)", category: "task",
             title: "Task \(what.lowercased()): \(Self.clip(t.title, 60))",
             subtitle: "\(t.displayMachine) · \(t.folder)",
             body: Self.clip(t.error ?? t.result ?? ""),
             info: ["kind": "task", "task": t.id], enabled: enabled)
    }

    func taskAwaitingTap(_ t: RelayTask, enabled: Bool) {
        post(id: "tap-\(t.id)", category: "tap",
             title: "Task waits for Start on \(t.displayMachine)",
             subtitle: t.folder,
             body: Self.clip(t.prompt),
             info: ["kind": "tap", "task": t.id], enabled: enabled)
    }

    func toolApproval(_ a: ToolApproval, task t: RelayTask, enabled: Bool) {
        let cats = a.categories.isEmpty ? "" : " (\(a.categories.joined(separator: ", ")))"
        post(id: "tool-\(a.id)", category: "tool",
             title: "Tool approval: \(a.tool)\(cats)",
             subtitle: "\(t.displayMachine) · \(Self.clip(t.title, 60))",
             body: Self.clip(a.summary),
             info: ["kind": "tool", "task": t.id, "id": a.id], enabled: enabled)
    }

    /// Takes away banners (delivered and still pending) for items decided here or elsewhere.
    func remove(_ ids: [String]) {
        guard !ids.isEmpty, let center else { return }
        center.removeDeliveredNotifications(withIdentifiers: ids)
        center.removePendingNotificationRequests(withIdentifiers: ids)
    }

    private func post(id: String, category: String, title: String, subtitle: String, body: String, info: [String: Any], enabled: Bool) {
        guard enabled, let center else { return }
        let c = UNMutableNotificationContent()
        c.title = title
        c.subtitle = subtitle
        c.body = body
        c.sound = .default
        c.categoryIdentifier = category
        c.userInfo = info
        center.add(UNNotificationRequest(identifier: id, content: c, trigger: nil))
    }

    // MARK: delegate

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let kind = info["kind"] as? String
        let action = response.actionIdentifier
        Task { @MainActor in
            let state = AppState.shared
            switch (kind, action) {
            case ("post", "post.send"):
                if let id = info["id"] as? Int { await state.decidePost(id, .approve) }
            case ("post", "post.reject"):
                if let id = info["id"] as? Int { await state.decidePost(id, .reject) }
            case ("approval", "approval.approve"):
                if let id = info["id"] as? String { await state.decideApproval(id, .approve) }
            case ("approval", "approval.reject"):
                if let id = info["id"] as? String { await state.decideApproval(id, .reject) }
            case ("tool", "approval.approve"):
                if let t = info["task"] as? String, let id = info["id"] as? String { await state.decideTool(task: t, approval: id, .approve) }
            case ("tool", "approval.reject"):
                if let t = info["task"] as? String, let id = info["id"] as? String { await state.decideTool(task: t, approval: id, .reject) }
            case ("tap", "task.start"):
                if let t = info["task"] as? String { await state.startTask(t) }
            case ("task", _), ("tap", _), ("tool", _):
                state.focusTask = info["task"] as? String
                state.showMain(section: .tasks)
            case ("message", _):
                state.showMain(room: info["room"] as? String, thread: info["thread"] as? String)
            default:
                state.showMain(section: .approvals)
            }
            completionHandler()
        }
    }
}
