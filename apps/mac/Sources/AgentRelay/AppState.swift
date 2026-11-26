import AppKit
import RelayKit
import SwiftUI

enum SidebarItem: String, CaseIterable, Identifiable, Hashable {
    // Appended at the end so Cmd+1..6 keep their 0.4.0 meaning; Tasks is Cmd+7, Machines Cmd+8.
    case team, rooms, approvals, feed, audit, tokens, tasks, machines
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    var symbol: String {
        switch self {
        case .team: return "person.3"
        case .rooms: return "bubble.left.and.bubble.right"
        case .approvals: return "checkmark.seal"
        case .feed: return "text.bubble"
        case .audit: return "list.bullet.clipboard"
        case .tokens: return "key"
        case .tasks: return "checklist"
        case .machines: return "laptopcomputer.and.iphone"
        }
    }
}

/// What the team switcher filters rooms, feed and held posts by.
enum TeamFilter: Hashable {
    case all
    case direct
    case team(String)
}

/// Everything the UI shows, plus the polling loop. One instance per app.
@MainActor
final class AppState: ObservableObject {
    static let shared = AppState()

    // Session
    @Published private(set) var client: RelayClient?
    @Published var me: MeResponse?
    @Published var signInMessage: String?
    /// The relay answered 401 (token revoked or wrong). Polling stops; the token stays in
    /// the Keychain until the owner signs out or signs in again, so Retry can still work.
    @Published var authRejected: String?
    /// Bumped by Refresh (Cmd+R) so views with their own data (Tokens, Audit) reload too.
    @Published var refreshToken = 0

    // Data
    @Published private(set) var summary = Summary()
    @Published private(set) var pending = PendingResponse()
    @Published private(set) var feed: [ConsoleMessage] = [] // newest first
    @Published private(set) var rooms: [Room] = []
    @Published private(set) var teams: [Team] = []
    /// False against a relay older than 0.4.0 (no /owner/teams): the team UI hides.
    @Published private(set) var teamsSupported = false
    @Published var teamFilter: TeamFilter = .all

    // Tasks between own machines (0.5.0). False against an older relay: the UI hides.
    @Published var tasksSupported = false
    @Published var machines: [Machine] = []
    /// Newest first, merged from the recent list and the waiting ones.
    @Published var tasks: [RelayTask] = []
    /// `me.pendingTasks`: awaiting tap plus pending tool approvals.
    @Published var pendingTasks = 0
    @Published var focusTask: String?
    @Published var focusMachine: String?
    @Published var machineTab: MachineTab = .overview
    @Published var showNewTask = false
    /// Snapshot fixtures: no server, no client; data comes from `Fixtures`.
    @Published var fixtureMode = false
    var knownTaskStatus: [String: TaskStatus] = [:]
    var knownToolApprovals = Set<String>()
    /// Notification ids of task items shown as waiting at the last poll (taps, tool approvals).
    var waitingTaskNotes = Set<String>()
    /// `summary.pendingTasks` at the last poll: a change triggers a task list refetch.
    var lastPendingTasks: Int?
    var tasksPrimed = false

    // Status
    @Published var online = true
    @Published private(set) var lastError: String?
    @Published private(set) var lastSync: Date?
    @Published var actionError: String?
    @Published var busy: Set<String> = []

    // Navigation
    @Published var selection: SidebarItem? = .approvals
    @Published var focusRoom: String?
    @Published var focusThread: String?
    @Published var mainWindowVisible = false { didSet { updateDockBadge() } }

    var openMainWindowAction: (() -> Void)?

    @Published var notificationsEnabled: Bool = UserDefaults.standard.object(forKey: "notificationsEnabled") as? Bool ?? true {
        didSet { defaults.set(notificationsEnabled, forKey: "notificationsEnabled") }
    }

    private let defaults = UserDefaults.standard
    private var pollTask: Task<Void, Never>?
    private var primed = false
    private var feedCursor = 0
    private var knownPosts = Set<Int>()
    private var knownApprovals = Set<String>()
    private var tickCount = 0

    var savedServer: String { defaults.string(forKey: "server") ?? "" }
    var savedOwner: String { defaults.string(forKey: "owner") ?? "" }
    var signedIn: Bool { (client != nil || fixtureMode) && me != nil && authRejected == nil }
    var canSend: Bool { me?.token.send ?? false }
    var pendingCount: Int { summary.pendingPosts + summary.pendingApprovals + pendingTasks }

    private init() {}

    // MARK: session

    /// Restores a saved session (UserDefaults + Keychain) at launch.
    func restore() {
        guard let url = RelayClient.normalize(server: savedServer), !savedOwner.isEmpty,
              let token = Keychain.load(account: Keychain.account(owner: savedOwner, server: url)) else { return }
        let c = RelayClient(baseURL: url, owner: savedOwner, token: token)
        Task {
            do {
                let me = try await c.me()
                self.begin(client: c, me: me)
            } catch let e as RelayError where e.status == 401 || e.status == 403 {
                self.client = c
                self.authRejected = "The relay rejected the saved token (revoked or wrong)."
            } catch {
                // Offline at launch: keep the session and let polling retry.
                self.client = c
                self.online = false
                self.lastError = error.localizedDescription
                self.retryMe(c)
            }
        }
    }

    private func retryMe(_ c: RelayClient) {
        Task {
            var delay: UInt64 = 5
            while client?.baseURL == c.baseURL, me == nil {
                try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
                delay = min(delay * 2, 30)
                if let me = try? await c.me() { begin(client: c, me: me); return }
            }
        }
    }

    func signIn(server: String, username: String, token: String) async throws {
        let user = username.trimmingCharacters(in: .whitespaces)
        let tok = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if user.contains("@") { throw SignInError("Use the username (owner id), not an email.") }
        if user.isEmpty { throw SignInError("Enter the username.") }
        if tok.isEmpty { throw SignInError("Enter the token.") }
        guard let url = RelayClient.normalize(server: server) else { throw SignInError("The server URL is not valid.") }
        let c = RelayClient(baseURL: url, owner: user, token: tok)
        let me = try await c.me()
        if let old = client {
            // Signing in again (after a 401 or as someone else): drop the old session, and
            // its Keychain item unless the new token is about to replace it.
            let same = Keychain.account(owner: old.owner, server: old.baseURL) == Keychain.account(owner: user, server: url)
            signOut(deleteToken: !same)
        }
        guard Keychain.save(token: tok, account: Keychain.account(owner: user, server: url)) else {
            throw SignInError("Could not save the token in the Keychain.")
        }
        defaults.set(url.absoluteString, forKey: "server")
        defaults.set(user, forKey: "owner")
        signInMessage = nil
        begin(client: c, me: me)
    }

    func signOut(message: String? = nil, deleteToken: Bool = true) {
        pollTask?.cancel()
        pollTask = nil
        if deleteToken, let c = client { Keychain.delete(account: Keychain.account(owner: c.owner, server: c.baseURL)) }
        authRejected = nil
        client = nil
        me = nil
        summary = Summary()
        pending = PendingResponse()
        feed = []
        rooms = []
        teams = []
        teamsSupported = false
        teamFilter = .all
        resetTasks()
        primed = false
        feedCursor = 0
        knownPosts = []
        knownApprovals = []
        online = true
        lastError = nil
        signInMessage = message
        selection = .approvals
        updateDockBadge()
    }

    func begin(client c: RelayClient, me m: MeResponse) {
        client = c
        me = m
        authRejected = nil
        online = true
        lastError = nil
        startPolling()
    }

    // MARK: polling

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            var delay: UInt64 = 5
            while !Task.isCancelled {
                guard let self else { return }
                let ok = await self.tick()
                delay = ok ? 5 : min(max(delay * 2, 10), 30)
                try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
            }
        }
    }

    func refreshNow() {
        refreshToken += 1
        Task { _ = await tick(force: true) }
    }

    /// After a 401: polling stops, data and the Keychain token stay until Retry, Sign In or Sign Out.
    private func rejectAuth() {
        pollTask?.cancel()
        pollTask = nil
        authRejected = "The relay rejected the token (revoked or wrong)."
        updateDockBadge()
    }

    /// Retry after a 401 with the same token (for example after the relay was fixed).
    func retryAuth() async {
        guard let c = client else { return }
        do {
            let m = try await c.me()
            begin(client: c, me: m)
        } catch let e as RelayError where e.status == 401 || e.status == 403 {
            authRejected = "Still rejected: \(e.reason)"
        } catch {
            authRejected = error.localizedDescription
        }
    }

    @discardableResult
    private func tick(force: Bool = false) async -> Bool {
        guard let c = client else { return false }
        tickCount += 1
        do {
            let s = try await c.summary()
            let first = !primed || force
            let feedMoved = s.feedCursor != feedCursor
            if first || feedMoved { try await loadFeed(c, cursor: s.feedCursor) }
            if first || feedMoved || tickCount % 6 == 0
                || s.pendingPosts != summary.pendingPosts || s.pendingApprovals != summary.pendingApprovals {
                try await loadPending(c)
            }
            if first || feedMoved || s.unread != summary.unread || s.unreadOwn != summary.unreadOwn || tickCount % 12 == 0 {
                rooms = try await c.rooms().rooms
            }
            if first || tickCount % 12 == 0 { await loadTeams(c) }
            await loadTasksData(c, summary: s, first: first, tick: tickCount)
            summary = s
            primed = true
            online = true
            lastError = nil
            lastSync = Date()
            updateDockBadge()
            return true
        } catch let e as RelayError where e.status == 401 {
            rejectAuth()
            return false
        } catch {
            online = false
            lastError = error.localizedDescription
            return false
        }
    }

    func loadTeams(_ c: RelayClient? = nil) async {
        guard let c = c ?? client else { return }
        do {
            teams = try await c.teams().teams.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            teamsSupported = true
            if case let .team(id) = teamFilter, !teams.contains(where: { $0.id == id }) { teamFilter = .all }
        } catch let e as RelayError where e.status == 404 {
            teams = []
            teamsSupported = false
            teamFilter = .all
            if selection == .team { selection = .approvals }
        } catch {
            // Keep what we had; the summary call reports connectivity.
        }
    }

    /// Replaces one team after an admin change.
    func apply(team t: Team) {
        if let i = teams.firstIndex(where: { $0.id == t.id }) { teams[i] = t } else { teams.append(t) }
    }

    // MARK: team filter

    func team(_ id: String?) -> Team? { id.flatMap { id in teams.first { $0.id == id } } }
    func room(_ id: String) -> Room? { rooms.first { $0.room == id } }

    func passes(room id: String) -> Bool {
        switch teamFilter {
        case .all: return true
        case .direct: return room(id)?.team == nil
        case let .team(t): return room(id)?.team == t || team(t)?.rooms.contains(id) == true
        }
    }

    var filteredRooms: [Room] { rooms.filter { passes(room: $0.room) } }
    var filteredFeed: [ConsoleMessage] { teamFilter == .all ? feed : feed.filter { passes(room: $0.room) } }
    var filteredPosts: [ConsoleMessage] { pending.posts.filter { passes(room: $0.room) } }
    /// Action approvals are scoped to the owner, not a room, so every filter shows them.
    var filteredApprovals: [OwnerApproval] { pending.approvals }
    var filteredUnread: Int { filteredRooms.reduce(0) { $0 + $1.unread } }
    /// Tasks are scoped to the owner's machines, so every team filter shows them too.
    var filteredPendingCount: Int { filteredPosts.count + filteredApprovals.count + pendingTasks }

    var filterTitle: String {
        switch teamFilter {
        case .all: return "All"
        case .direct: return "Direct"
        case let .team(id): return team(id)?.name ?? id
        }
    }

    /// Display name for an owner id: me, a team member, or someone seen in a room.
    func personName(_ id: String) -> String {
        if id == me?.owner.id { return me?.owner.name ?? id }
        for t in teams { if let m = t.members.first(where: { $0.id == id }) { return m.name } }
        for r in rooms { if let p = r.people?.first(where: { $0.id == id }) { return p.name } }
        return id
    }

    private func loadFeed(_ c: RelayClient, cursor: Int) async throws {
        var after = primed ? feedCursor : max(0, cursor - 200)
        var fresh: [ConsoleMessage] = []
        for _ in 0..<5 {
            let page = try await c.feed(after: after, limit: 200)
            fresh += page.messages
            after = page.cursor
            if !page.more { break }
        }
        var byId = Dictionary(uniqueKeysWithValues: feed.map { ($0.id, $0) })
        for m in fresh where (byId[m.id]?.ver ?? -1) < m.ver {
            let wasDelivered = byId[m.id]?.status == .delivered
            byId[m.id] = m
            if primed, !m.mine, m.status == .delivered, !m.read, !wasDelivered {
                Notifier.shared.message(m, enabled: notificationsEnabled)
            }
        }
        feed = Array(byId.values.sorted { $0.ver > $1.ver }.prefix(500))
        feedCursor = max(after, cursor)
    }

    private func loadPending(_ c: RelayClient) async throws {
        let p = try await c.pending()
        // Decided elsewhere (Telegram, another console): take their banners away.
        let posts = Set(p.posts.map(\.id)), approvals = Set(p.approvals.map(\.id))
        Notifier.shared.remove(pending.posts.map(\.id).filter { !posts.contains($0) }.map { "post-\($0)" }
            + pending.approvals.map(\.id).filter { !approvals.contains($0) }.map { "approval-\($0)" })
        if primed {
            for post in p.posts where !knownPosts.contains(post.id) {
                Notifier.shared.heldPost(post, enabled: notificationsEnabled)
            }
            for a in p.approvals where !knownApprovals.contains(a.id) {
                Notifier.shared.approval(a, enabled: notificationsEnabled)
            }
        }
        knownPosts.formUnion(p.posts.map(\.id))
        knownApprovals.formUnion(p.approvals.map(\.id))
        pending = p
    }

    // MARK: actions

    func decidePost(_ id: Int, _ d: Decision) async {
        guard let c = client, canSend else { return }
        let key = "post:\(id)"
        busy.insert(key)
        defer { busy.remove(key) }
        do {
            let r = try await c.decidePost(id: id, d)
            Notifier.shared.remove(["post-\(id)"])
            if r.outcome == .gone { actionError = "That post was already decided or expired." }
            pending = PendingResponse(posts: pending.posts.filter { $0.id != id }, approvals: pending.approvals)
        } catch {
            actionError = error.localizedDescription
        }
        _ = await tick(force: true)
    }

    func decideApproval(_ id: String, _ d: Decision) async {
        guard let c = client, canSend else { return }
        let key = "approval:\(id)"
        busy.insert(key)
        defer { busy.remove(key) }
        do {
            _ = try await c.decideApproval(id: id, d)
            Notifier.shared.remove(["approval-\(id)"])
            pending = PendingResponse(posts: pending.posts, approvals: pending.approvals.filter { $0.id != id })
        } catch {
            actionError = error.localizedDescription
        }
        _ = await tick(force: true)
    }

    /// Runs a team admin change and applies the team the server returns.
    @discardableResult
    func teamChange(_ key: String, _ f: @escaping (RelayClient) async throws -> Team) async -> Bool {
        guard let c = client, canSend else { return false }
        busy.insert(key)
        defer { busy.remove(key) }
        do {
            apply(team: try await f(c))
            rooms = (try? await c.rooms().rooms) ?? rooms
            return true
        } catch {
            actionError = error.localizedDescription
            return false
        }
    }

    /// Marks a thread (or with `thread: nil` the whole room) read. Returns the reason on
    /// failure so the view can show it inline (read state only, so no alert).
    @discardableResult
    func ack(room: String, thread: String?) async -> String? {
        guard let c = client else { return "Not signed in." }
        do {
            try await c.ack(room: room, thread: thread)
            _ = await tick(force: true)
            return nil
        } catch {
            return (error as? RelayError)?.reason ?? error.localizedDescription
        }
    }

    // MARK: window, dock

    func showMain(room: String? = nil, thread: String? = nil, section: SidebarItem? = nil) {
        if let section { selection = section }
        if let room {
            if !passes(room: room) { teamFilter = .all }
            focusRoom = room; focusThread = thread; selection = .rooms
        }
        if let open = openMainWindowAction {
            open() // SwiftUI brings the single Window to the front or recreates it.
        } else if let w = NSApp.windows.first(where: { $0.title == "Agent Relay" }) {
            w.makeKeyAndOrderFront(nil)
        } else {
            openMainFromWindowMenu()
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Before any view has appeared there is no `openWindow` handle. SwiftUI lists
    /// every `Window` scene in the Window menu, so trigger that item instead.
    private func openMainFromWindowMenu() {
        guard let items = NSApp.windowsMenu?.items ?? NSApp.mainMenu?.items.compactMap(\.submenu).flatMap(\.items),
              let item = items.first(where: { $0.title == "Agent Relay" }),
              let action = item.action else { return }
        NSApp.sendAction(action, to: item.target, from: item)
    }

    func updateDockBadge() {
        let n = pendingCount
        NSApp?.dockTile.badgeLabel = (signedIn && n > 0) ? String(n) : nil
    }
}

struct SignInError: LocalizedError {
    let message: String
    init(_ m: String) { message = m }
    var errorDescription: String? { message }
}

// MARK: snapshot mode

/// Hidden mode for docs screenshots (window capture does not work everywhere):
///
///   AGENT_RELAY_SNAPSHOT_DIR=<dir> AGENT_RELAY_SERVER=<url> AGENT_RELAY_USER=<owner> \
///   AGENT_RELAY_TOKEN=<console token> [AGENT_RELAY_SNAPSHOT_ROOM=room/thread] \
///   [AGENT_RELAY_SNAPSHOT_TEAM_ROOM=room/thread] AgentRelay
///
/// Signs in from the environment (never the Keychain), renders every section in
/// light and dark to <dir>/<section>-<light|dark>.png at 2x, then quits. Does
/// nothing unless AGENT_RELAY_SNAPSHOT_DIR is set.
enum SnapshotMode {
    static var dir: String? { ProcessInfo.processInfo.environment["AGENT_RELAY_SNAPSHOT_DIR"] }

    @MainActor
    static func run(_ state: AppState) {
        let env = ProcessInfo.processInfo.environment
        if let dir, env["AGENT_RELAY_SNAPSHOT_FIXTURES"] == "1" { return runFixtures(state, dir: dir) }
        guard let dir, let url = RelayClient.normalize(server: env["AGENT_RELAY_SERVER"] ?? ""),
              let user = env["AGENT_RELAY_USER"], let tok = env["AGENT_RELAY_TOKEN"] else {
            FileHandle.standardError.write("snapshot: set AGENT_RELAY_SERVER, AGENT_RELAY_USER, AGENT_RELAY_TOKEN\n".data(using: .utf8)!)
            exit(3)
        }
        func split(_ s: String?) -> (String, String)? {
            guard let s, let i = s.firstIndex(of: "/") else { return nil }
            return (String(s[..<i]), String(s[s.index(after: i)...]))
        }
        let focus = split(env["AGENT_RELAY_SNAPSHOT_ROOM"] ?? "alice-bob/launch-plan")
        let teamFocus = split(env["AGENT_RELAY_SNAPSHOT_TEAM_ROOM"])
        let c = RelayClient(baseURL: url, owner: user, token: tok)
        Task { @MainActor in
            guard let m = try? await c.me() else { exit(4) }
            state.begin(client: c, me: m)
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            for (name, look) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
                NSApp.appearance = NSAppearance(named: look)
                for item in SidebarItem.allCases {
                    if item == .team, !state.teamsSupported { continue }
                    state.teamFilter = .all
                    state.selection = item
                    if item == .rooms, let focus { state.focusRoom = focus.0; state.focusThread = focus.1 }
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    render(dir: dir, name: "\(item.rawValue)-\(name)")
                }
                if let teamFocus, let t = state.room(teamFocus.0)?.team {
                    state.teamFilter = .team(t)
                    state.selection = .rooms
                    state.focusRoom = teamFocus.0
                    state.focusThread = teamFocus.1
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    render(dir: dir, name: "rooms-team-\(name)")
                }
                renderSettings(state, dir: dir, name: "settings-\(name)")
            }
            exit(0)
        }
    }

    /// AGENT_RELAY_SNAPSHOT_FIXTURES=1: tasks and machines from fixture data, no server.
    @MainActor
    static func runFixtures(_ state: AppState, dir: String) {
        state.fixtureMode = true
        state.me = Fixtures.me
        state.online = true
        state.machines = Fixtures.machines
        state.tasks = Fixtures.tasks
        state.tasksSupported = true
        state.pendingTasks = state.tasksAwaitingTap.count + state.pendingToolApprovals.count
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            for (name, look) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
                NSApp.appearance = NSAppearance(named: look)
                let shots: [(String, () -> Void)] = [
                    ("tasks", { state.selection = .tasks; state.focusTask = "t-1042" }),
                    ("task-detail", { state.selection = .tasks; state.focusTask = "t-1038" }),
                    ("machines", { state.selection = .machines; state.focusMachine = "studio"; state.machineTab = .overview }),
                    ("policy", { state.selection = .machines; state.focusMachine = "studio"; state.machineTab = .policy }),
                    ("approvals-tasks", { state.selection = .approvals }),
                ]
                for (shot, setup) in shots {
                    setup()
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    render(dir: dir, name: "\(shot)-\(name)")
                }
                state.focusMachine = "studio"
                renderView(NewTaskSheet().environmentObject(state), size: NSSize(width: 600, height: 640), dir: dir, name: "new-task-\(name)")
            }
            exit(0)
        }
    }

    @MainActor
    static func renderView<V: View>(_ view: V, size: NSSize, dir: String, name: String) {
        let host = NSHostingView(rootView: view.frame(width: size.width).fixedSize(horizontal: false, vertical: true)
            .background(Color(nsColor: .windowBackgroundColor)))
        host.setFrameSize(host.fittingSize.height > 0 ? host.fittingSize : size)
        let win = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: host.frame.width, height: host.frame.height),
                           styleMask: [.titled], backing: .buffered, defer: false)
        win.contentView = host
        win.appearance = NSApp.appearance
        win.orderBack(nil)
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.8))
        write(host, dir: dir, name: name)
        win.orderOut(nil)
    }

    @MainActor
    private static func mainWindow() -> NSWindow? {
        NSApp.windows.first { $0.title == "Agent Relay" || $0.identifier?.rawValue.hasPrefix("main") == true }
    }

    @MainActor
    static func render(dir: String, name: String) {
        guard let w = mainWindow() else { return }
        if w.frame.size != NSSize(width: 1200, height: 780) {
            w.setContentSize(NSSize(width: 1200, height: 750))
        }
        guard let v = w.contentView?.superview ?? w.contentView else { return }
        write(v, dir: dir, name: name)
    }

    @MainActor
    static func renderSettings(_ state: AppState, dir: String, name: String) {
        let host = NSHostingView(rootView: SettingsView().environmentObject(state)
            .frame(width: 480, height: 640).background(Color(nsColor: .windowBackgroundColor)))
        let win = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: 480, height: 640), styleMask: [.titled], backing: .buffered, defer: false)
        win.contentView = host
        win.appearance = NSApp.appearance
        win.orderBack(nil)
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.8))
        write(host, dir: dir, name: name)
        win.orderOut(nil)
    }

    @MainActor
    private static func write(_ v: NSView, dir: String, name: String) {
        v.layoutSubtreeIfNeeded()
        let size = v.bounds.size
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * 2), pixelsHigh: Int(size.height * 2),
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return }
        rep.size = size
        v.cacheDisplay(in: v.bounds, to: rep)
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }
}
