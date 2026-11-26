import RelayKit
import ServiceManagement
import SwiftUI

// MARK: root

struct RootView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.openWindow) private var openWindow
    @State private var reSignIn = false

    var body: some View {
        Group {
            if state.signedIn {
                MainView()
            } else if state.authRejected != nil && !reSignIn {
                AuthRejectedView(signInAgain: { reSignIn = true })
            } else {
                SignInView()
            }
        }
        .onAppear {
            state.mainWindowVisible = true
            state.openMainWindowAction = { openWindow(id: "main") }
        }
        // Window closed: the app stays in the Dock; clicking the icon reopens it.
        .onDisappear { state.mainWindowVisible = false }
        .onChange(of: state.authRejected) { if $0 == nil { reSignIn = false } }
    }
}

/// After a 401: the token stays in the Keychain until the owner chooses. Retry tries it again,
/// Sign In Again replaces it, Sign Out deletes it.
struct AuthRejectedView: View {
    @EnvironmentObject var state: AppState
    let signInAgain: () -> Void
    @State private var retrying = false

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "key.slash").font(.system(size: 40)).foregroundStyle(.orange)
            Text("Signed out by the relay").font(.title2.weight(.semibold))
            Text(state.authRejected ?? "")
                .foregroundStyle(.secondary).multilineTextAlignment(.center)
            Text("The token is still in your Keychain. Retry if the relay was misconfigured, or sign in with a new token.")
                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
                .frame(maxWidth: 380)
            HStack {
                Button("Sign Out", role: .destructive) { state.signOut() }
                Button("Sign In Again") { signInAgain() }
                Button {
                    retrying = true
                    Task { await state.retryAuth(); retrying = false }
                } label: {
                    if retrying { ProgressView().controlSize(.small) } else { Text("Retry") }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(retrying)
            }
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct MainView: View {
    @EnvironmentObject var state: AppState

    private var sections: [SidebarItem] {
        SidebarItem.allCases.filter {
            ($0 != .team || state.teamsSupported) && (![.tasks, .machines].contains($0) || state.tasksSupported)
        }
    }

    var body: some View {
        NavigationSplitView {
            List(selection: $state.selection) {
                Section("Workspace") {
                    ForEach(sections.filter { [.team, .rooms, .approvals, .feed].contains($0) }) { row($0) }
                }
                if state.tasksSupported {
                    Section("Machines") {
                        ForEach(sections.filter { [.tasks, .machines].contains($0) }) { row($0) }
                    }
                }
                Section("Account") {
                    ForEach(sections.filter { [.audit, .tokens].contains($0) }) { row($0) }
                }
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 190, ideal: 220, max: 280)
            .safeAreaInset(edge: .top) {
                if state.teamsSupported { TeamSwitcher().padding(.horizontal, 10).padding(.bottom, 4) }
            }
            .safeAreaInset(edge: .bottom) { SidebarFooter() }
        } detail: {
            VStack(spacing: 0) {
                OfflineBanner()
                detail
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .alert("Action failed", isPresented: Binding(get: { state.actionError != nil }, set: { if !$0 { state.actionError = nil } })) {
            Button("OK") { state.actionError = nil }
        } message: {
            Text(state.actionError ?? "")
        }
    }

    private func row(_ item: SidebarItem) -> some View {
        // Fixed icon column: on macOS 26+ wide symbols (person.3, laptopcomputer.and.iphone)
        // in a sidebar Label spill over the title, so the icon gets its own centred slot.
        Label {
            Text(item.title)
        } icon: {
            Image(systemName: item.symbol)
                .symbolRenderingMode(.monochrome)
                .imageScale(.medium)
                .frame(width: 22, alignment: .center)
        }
        .badge(badge(item))
            .tag(item)
    }

    private func badge(_ item: SidebarItem) -> Int {
        switch item {
        case .approvals: return state.filteredPendingCount
        case .rooms: return state.filteredUnread
        case .tasks: return state.tasks.filter { !$0.status.terminal }.count
        case .team:
            if case let .team(id) = state.teamFilter { return state.team(id)?.invites.count ?? 0 }
            return 0
        default: return 0
        }
    }

    @ViewBuilder private var detail: some View {
        switch state.selection ?? .approvals {
        case .team: TeamView()
        case .rooms: RoomsView()
        case .approvals: ApprovalsView()
        case .feed: FeedView()
        case .audit: AuditView()
        case .tokens: TokensView()
        case .tasks: TasksView()
        case .machines: MachinesView()
        }
    }
}

/// Picks what rooms, feed and held posts show: everything, one team, or direct rooms.
struct TeamSwitcher: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        Menu {
            Button { state.teamFilter = .all } label: {
                Label("All", systemImage: state.teamFilter == .all ? "checkmark" : "square.stack")
            }
            if !state.teams.isEmpty {
                Section("Teams") {
                    ForEach(state.teams) { t in
                        Button { state.teamFilter = .team(t.id) } label: {
                            Label(t.name, systemImage: state.teamFilter == .team(t.id) ? "checkmark" : "person.3")
                        }
                    }
                }
            }
            Divider()
            Button { state.teamFilter = .direct } label: {
                Label("Direct", systemImage: state.teamFilter == .direct ? "checkmark" : "person.2")
            }
        } label: {
            HStack(spacing: 8) {
                badge
                VStack(alignment: .leading, spacing: 0) {
                    Text(state.filterTitle).font(.headline).lineLimit(1)
                    Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(.secondary)
            }
            .padding(8)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.primary.opacity(0.06)))
            .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .help("Show one team, direct rooms or everything")
    }

    @ViewBuilder private var badge: some View {
        switch state.teamFilter {
        case let .team(id): TeamBadge(id: id, name: state.filterTitle, size: 28)
        case .direct: symbolBadge("person.2.fill", .teal)
        case .all: symbolBadge("square.stack.fill", .accentColor)
        }
    }

    private func symbolBadge(_ s: String, _ c: Color) -> some View {
        RoundedRectangle(cornerRadius: 7, style: .continuous)
            .fill(c.gradient)
            .overlay(Image(systemName: s).font(.system(size: 12, weight: .semibold)).foregroundStyle(.white))
            .frame(width: 28, height: 28)
    }

    private var subtitle: String {
        switch state.teamFilter {
        case .all: return state.teams.isEmpty ? "All rooms" : "\(state.teams.count) \(state.teams.count == 1 ? "team" : "teams") · Direct"
        case .direct: return "Rooms outside teams"
        case let .team(id):
            guard let t = state.team(id) else { return "Team" }
            return "\(t.members.count) members · \(t.role == .admin ? "Admin" : "Member")"
        }
    }
}

struct SidebarFooter: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        HStack(spacing: 8) {
            ZStack(alignment: .bottomTrailing) {
                Avatar(id: state.me?.owner.id ?? "", name: state.me?.owner.name ?? "", size: 26)
                Circle()
                    .fill(state.online ? Color.green : Color.orange)
                    .frame(width: 8, height: 8)
                    .overlay(Circle().stroke(Color(nsColor: .windowBackgroundColor), lineWidth: 1.5))
                    .accessibilityLabel(state.online ? "Online" : "Offline")
            }
            VStack(alignment: .leading, spacing: 0) {
                Text(state.me?.owner.name ?? "").font(.callout.weight(.medium)).lineLimit(1)
                Text(state.online ? "@\(state.me?.owner.id ?? "") · online" : "offline, retrying")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }
}

// MARK: sign-in

struct SignInView: View {
    @EnvironmentObject var state: AppState
    @State private var server = ""
    @State private var username = ""
    @State private var token = ""
    @State private var error: String?
    @State private var working = false

    private var usernameHint: String? {
        username.contains("@") ? "Username, not email: use the owner id (for example alice)." : nil
    }

    var body: some View {
        VStack(spacing: 18) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 84, height: 84)
            VStack(spacing: 4) {
                Text("Sign in to Agent Relay").font(.title2.weight(.semibold))
                Text("Approve what your agents send and see what other agents wrote.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Form {
                TextField("Server", text: $server, prompt: Text("https://relay.example.org"))
                TextField("Username", text: $username, prompt: Text("alice"))
                    .textContentType(.username)
                if let usernameHint {
                    Label(usernameHint, systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(.red)
                }
                SecureField("Console token", text: $token)
            }
            .formStyle(.grouped)
            .scrollDisabledIfAvailable()
            .frame(width: 420, height: usernameHint == nil ? 150 : 180)
            .disabled(working)
            if let msg = error ?? state.signInMessage {
                Label(msg, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout).foregroundStyle(.red).frame(width: 400, alignment: .leading)
            }
            HStack {
                if working { ProgressView().controlSize(.small) }
                Button("Sign In") { submit() }
                    .keyboardShortcut(.defaultAction)
                    .controlSize(.large)
                    .disabled(working || usernameHint != nil || username.isEmpty || token.isEmpty || server.isEmpty)
            }
            Text("Create a console token with `relay owner console <username>`. It is kept in your Keychain.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear {
            if server.isEmpty { server = state.savedServer }
            if username.isEmpty { username = state.savedOwner }
        }
    }

    private func submit() {
        working = true
        error = nil
        Task {
            do {
                try await state.signIn(server: server, username: username, token: token)
                token = ""
            } catch {
                self.error = error.localizedDescription
            }
            working = false
        }
    }
}

extension View {
    @ViewBuilder func scrollDisabledIfAvailable() -> some View {
        if #available(macOS 13.0, *) { scrollDisabled(true) } else { self }
    }
}

// MARK: feed

struct FeedView: View {
    @EnvironmentObject var state: AppState
    @State private var room = ""

    var body: some View {
        Group {
            if shown.isEmpty {
                EmptyState("No messages", symbol: "text.bubble",
                           message: "Messages from every room you are in show up here, newest first.")
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(shown) { m in
                            MessageBubble(m: m, showRoom: true)
                                .contentShape(Rectangle())
                                .onTapGesture(count: 2) { state.showMain(room: m.room, thread: m.thread) }
                                .help("Double-click to open the thread")
                        }
                    }
                    .padding(20)
                    .frame(maxWidth: 900)
                    .frame(maxWidth: .infinity)
                }
                .background(Color(nsColor: .textBackgroundColor))
            }
        }
        .navigationTitle("Feed")
        .navigationSubtitle("\(shown.count) messages")
        .toolbar {
            ToolbarItem {
                Picker("Room", selection: $room) {
                    Text("All rooms").tag("")
                    Divider()
                    ForEach(state.filteredRooms) { Text(verbatim: $0.title.nilIfEmpty ?? $0.room).tag($0.room) }
                }
                .frame(width: 200)
                .help("Show one room")
            }
        }
        .onChange(of: state.teamFilter) { _ in room = "" }
    }

    private var shown: [ConsoleMessage] {
        room.isEmpty ? state.filteredFeed : state.filteredFeed.filter { $0.room == room }
    }
}

// MARK: audit

enum AuditSource: String, CaseIterable, Identifiable {
    case relay = "Relay", tasks = "Tasks"
    var id: String { rawValue }
}

/// Audit: the relay log, or (0.5.0) the task log of my machines.
struct AuditView: View {
    @EnvironmentObject var state: AppState
    @State private var source: AuditSource = .relay

    var body: some View {
        Group {
            if source == .tasks && state.tasksSupported { TaskLogView() } else { RelayAuditView() }
        }
        .toolbar {
            if state.tasksSupported {
                ToolbarItem(placement: .principal) {
                    Picker("Source", selection: $source) {
                        ForEach(AuditSource.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 160)
                }
            }
        }
    }
}

struct RelayAuditView: View {
    @EnvironmentObject var state: AppState
    @State private var entries: [AuditEntry] = []
    @State private var error: String?
    @State private var done = false
    @State private var loading = false

    var body: some View {
        VStack(spacing: 0) {
            if let error {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).padding(8)
            }
            Table(entries) {
                TableColumn("") { e in
                    Image(systemName: e.ok ? "checkmark.circle.fill" : "xmark.octagon.fill")
                        .foregroundStyle(e.ok ? Color.green : Color.red)
                        .help(e.ok ? "Succeeded" : "Refused or failed")
                        .accessibilityLabel(e.ok ? "Succeeded" : "Refused or failed")
                }.width(22)
                TableColumn("Time") { Text(Fmt.when($0.at)).monospacedDigit().help(Fmt.stamp($0.at)) }
                    .width(min: 70, ideal: 110)
                TableColumn("Action") { e in
                    Label(e.action, systemImage: Self.symbol(e.action))
                }.width(min: 120, ideal: 190)
                TableColumn("Actor") { e in
                    HStack(spacing: 4) {
                        Image(systemName: AgentKind.symbol(e.actor)).foregroundStyle(.secondary)
                        Text(verbatim: e.actor)
                    }
                }.width(min: 80, ideal: 140)
                TableColumn("Target") { Text(verbatim: $0.target ?? "").foregroundStyle(.secondary) }
                    .width(min: 60, ideal: 160)
                TableColumn("Detail") { Text(verbatim: $0.detail ?? "").foregroundStyle(.secondary).help($0.detail ?? "") }
            }
            .overlay {
                if entries.isEmpty {
                    if loading { ProgressView() } else if error == nil {
                        EmptyState("No audit entries", symbol: "list.bullet.rectangle", message: "Decisions, posts and token changes show up here.")
                    }
                }
            }
        }
        .navigationTitle("Audit")
        .navigationSubtitle("\(entries.count) entries")
        .toolbar {
            ToolbarItemGroup {
                Button { Task { await load(reset: false) } } label: {
                    Label("Load Older", systemImage: "clock.arrow.circlepath")
                }
                .disabled(done || loading)
                .help("Load older entries")
                Button { Task { await load(reset: true) } } label: {
                    Label("Reload", systemImage: "arrow.clockwise")
                }
                .help("Reload")
            }
        }
        .task(id: "\(state.summary.auditCursor)|\(state.refreshToken)") { await load(reset: true) }
    }

    static func symbol(_ action: String) -> String {
        let a = action.lowercased()
        if a.contains("reject") || a.contains("revoke") || a.contains("remove") { return "xmark.circle" }
        if a.contains("approv") || a.contains("decide") { return "checkmark.seal" }
        if a.contains("post") { return "text.bubble" }
        if a.contains("token") { return "key" }
        if a.contains("team") || a.contains("member") || a.contains("invite") { return "person.3" }
        if a.contains("room") { return "bubble.left.and.bubble.right" }
        if a.contains("ack") || a.contains("read") { return "eye" }
        return "circle.dashed"
    }

    private func load(reset: Bool) async {
        guard let c = state.client else { return }
        loading = true
        defer { loading = false }
        do {
            let before = reset ? nil : entries.map(\.id).min()
            let r = try await c.audit(before: before, limit: 100)
            entries = reset ? r.entries : entries + r.entries
            done = r.entries.count < 100
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// MARK: tokens

struct TokensView: View {
    @EnvironmentObject var state: AppState
    @State private var tokens: [RelayToken] = []
    @State private var error: String?
    @State private var confirm: RelayToken?
    @State private var showRevoked = false
    @State private var loading = false
    @State private var loaded = false

    private var shown: [RelayToken] { showRevoked ? tokens : tokens.filter { $0.revokedAt == nil } }

    var body: some View {
        VStack(spacing: 0) {
            if !state.canSend { ReadOnlyNote().padding(8) }
            if let error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).padding(8) }
            Table(shown) {
                TableColumn("Token") { t in
                    HStack(spacing: 8) {
                        Image(systemName: t.kind == .console ? "macwindow" : t.kind == .worker ? "desktopcomputer" : AgentKind.symbol(t.label))
                            .frame(width: 18)
                            .foregroundStyle(t.revokedAt == nil ? Color.accentColor : Color.secondary)
                        Text(verbatim: t.label).strikethrough(t.revokedAt != nil)
                        if t.current { StateLabel(text: "This app", symbol: "checkmark", color: .accentColor) }
                    }
                }.width(min: 140, ideal: 200)
                TableColumn("Kind") { Text($0.kind == .console ? "Console" : $0.kind == .worker ? "Worker" : "Agent").foregroundStyle(.secondary) }
                    .width(60)
                TableColumn("Access") { t in
                    HStack(spacing: 4) {
                        ForEach(t.grants, id: \.self) { GrantChip(grant: $0) }
                    }
                }.width(min: 120, ideal: 240)
                TableColumn("Last used") { t in
                    Text(t.revokedAt.map { "revoked " + Fmt.ago($0) } ?? t.lastUsedAt.map { Fmt.ago($0) } ?? "never")
                        .foregroundStyle(.secondary)
                        .help(Fmt.stamp(t.revokedAt ?? t.lastUsedAt))
                }.width(min: 70, ideal: 110)
                TableColumn("") { t in
                    if t.revokedAt == nil {
                        Button("Revoke", role: .destructive) { confirm = t }
                            .controlSize(.small)
                            .disabled(t.current || !state.canSend)
                            .help(t.current ? "The token this app is signed in with cannot be revoked here." : "Revoke \(t.label)")
                    }
                }.width(70)
            }
            .overlay {
                if shown.isEmpty {
                    if !loaded { ProgressView() } else if error == nil {
                        EmptyState(tokens.isEmpty ? "No tokens" : "No active tokens", symbol: "key",
                                   message: tokens.isEmpty ? "Create one with `relay owner token`." : "Turn on Show Revoked to see revoked tokens.")
                    }
                }
            }
        }
        .navigationTitle("Tokens")
        .navigationSubtitle("\(tokens.filter { $0.revokedAt == nil }.count) active")
        .toolbar {
            ToolbarItem {
                Toggle(isOn: $showRevoked) { Label("Show Revoked", systemImage: "eye.slash") }
                    .help("Show revoked tokens")
            }
            ToolbarItem {
                Button { Task { await load() } } label: { Label("Reload", systemImage: "arrow.clockwise") }
                    .disabled(loading)
                    .help("Reload (⌘R)")
            }
        }
        .task(id: state.refreshToken) { await load() }
        .confirmationDialog("Revoke token \"\(confirm?.label ?? "")\"?", isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible) {
            Button("Revoke \(confirm?.label ?? "")", role: .destructive) {
                if let t = confirm { Task { await revoke(t) } }
            }
            Button("Cancel", role: .cancel) { confirm = nil }
        } message: {
            Text("The agent using this token loses access at once. This cannot be undone.")
        }
    }

    private func load() async {
        guard let c = state.client else { return }
        loading = true
        defer { loading = false; loaded = true }
        do {
            tokens = try await c.tokens(all: true).tokens
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func revoke(_ t: RelayToken) async {
        guard let c = state.client else { return }
        do {
            try await c.revoke(label: t.label)
        } catch {
            self.error = error.localizedDescription
        }
        confirm = nil
        await load()
    }
}

/// One grant as a small chip: `peer:ops` read/write, `team:acme`, `approval:ops`.
struct GrantChip: View {
    let grant: TokenGrant

    var body: some View {
        let parts = grant.channel.split(separator: ":", maxSplits: 1).map(String.init)
        let kind = parts.first ?? ""
        let name = parts.count > 1 ? parts[1] : grant.channel
        HStack(spacing: 3) {
            Image(systemName: kind == "team" ? "person.3.fill" : kind == "approval" ? "checkmark.seal.fill" : kind == "owner" ? "person.crop.circle.fill" : "bubble.left.fill")
                .font(.system(size: 8))
            Text(verbatim: name)
            Text(grant.send ? (grant.read ? "rw" : "w") : "r").foregroundStyle(.secondary)
        }
        .font(.caption)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Capsule().fill(color.opacity(0.14)))
        .foregroundStyle(color)
        .help("\(grant.channel): \(grant.read ? "read" : "")\(grant.read && grant.send ? " and " : "")\(grant.send ? "write" : "")")
    }

    private var color: Color {
        if grant.channel.hasPrefix("team:") { return .purple }
        if grant.channel.hasPrefix("approval:") { return .orange }
        if grant.channel.hasPrefix("owner:") { return .teal }
        return .blue
    }
}

// MARK: settings

struct SettingsView: View {
    @EnvironmentObject var state: AppState
    @State private var openAtLogin = SMAppService.mainApp.status == .enabled
    @AppStorage("showMenuBarExtra") private var showMenuBarExtra = false
    @State private var loginError: String?

    var body: some View {
        Form {
            Section {
                if let me = state.me {
                    HStack(spacing: 12) {
                        Avatar(id: me.owner.id, name: me.owner.name, size: 40)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(me.owner.name).font(.headline)
                            Text(verbatim: "@\(me.owner.id) · \(state.client?.baseURL.host ?? "")")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Sign Out") { state.signOut() }
                    }
                    .padding(.vertical, 2)
                    LabeledContent("Token", value: "\(me.token.label), \(state.canSend ? "read and decide" : "read only")")
                    LabeledContent("Time zone", value: me.owner.tz)
                    LabeledContent("Telegram bot") {
                        Label(me.channels.telegram ? "Connected" : "Not connected",
                              systemImage: me.channels.telegram ? "checkmark.circle.fill" : "minus.circle")
                            .foregroundStyle(me.channels.telegram ? Color.green : Color.secondary)
                    }
                    if let teams = me.teams, !teams.isEmpty {
                        LabeledContent("Teams", value: teams.map(\.name).joined(separator: ", "))
                    }
                } else {
                    Text("Signed out.").foregroundStyle(.secondary)
                }
            } header: {
                Text("Account")
            }
            Section("General") {
                Toggle("Notifications", isOn: $state.notificationsEnabled)
                Toggle("Show in menu bar", isOn: $showMenuBarExtra)
                Toggle("Open at login", isOn: $openAtLogin)
                    .onChange(of: openAtLogin) { on in
                        do {
                            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
                            loginError = nil
                        } catch {
                            loginError = error.localizedDescription
                        }
                    }
                if let loginError { Text(loginError).font(.caption).foregroundStyle(.red) }
            }
            Section("About") {
                LabeledContent("App version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev")
                LabeledContent("Relay version", value: state.me?.version ?? "")
                if let d = state.lastSync {
                    LabeledContent("Last sync", value: Fmt.full.string(from: d))
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 480)
        .frame(minHeight: 420)
    }
}

// MARK: menu bar popover

struct MenuContent: View {
    @EnvironmentObject var state: AppState
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 22, height: 22)
                Text("Agent Relay").font(.headline)
                Spacer()
                if state.signedIn {
                    Circle().fill(state.online ? Color.green : Color.orange).frame(width: 7, height: 7)
                        .accessibilityLabel(state.online ? "Online" : "Offline")
                    Text(state.online ? state.me?.owner.name ?? "" : "offline").font(.caption).foregroundStyle(.secondary)
                }
            }
            if !state.signedIn {
                Text(state.authRejected != nil ? "The relay rejected the token. Open Agent Relay to retry or sign in." : "Signed out.")
                    .foregroundStyle(.secondary)
            } else {
                if !state.canSend { ReadOnlyNote() }
                let listed = state.pending.posts.count + state.pending.approvals.count
                    + state.tasksAwaitingTap.count + state.pendingToolApprovals.count
                if listed == 0 {
                    if state.pendingCount > 0 {
                        Label("\(state.pendingCount) item\(state.pendingCount == 1 ? "" : "s") wait for you. Loading…", systemImage: "tray.full")
                            .font(.callout).foregroundStyle(.secondary)
                    } else {
                        Label("Nothing waits for you.", systemImage: "checkmark.circle")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(state.pending.posts) { PostCard(post: $0, compact: true) }
                        ForEach(state.pending.approvals) { ApprovalCard(a: $0, compact: true) }
                        ForEach(state.tasksAwaitingTap) { TapTaskCard(task: $0, compact: true) }
                        ForEach(state.pendingToolApprovals, id: \.approval.id) { ToolApprovalCard(task: $0.task, a: $0.approval, showTask: true, compact: true) }
                        if !state.feed.isEmpty {
                            HStack {
                                Text("Latest").font(.subheadline.weight(.semibold))
                                if state.summary.unread > 0 {
                                    Text("\(state.summary.unread) unread").font(.caption).foregroundStyle(Color.accentColor)
                                }
                            }
                            .padding(.top, 4)
                            ForEach(state.feed.prefix(4)) { m in
                                MessageBubble(m: m, showRoom: true)
                                    .lineLimit(4)
                                    .contentShape(Rectangle())
                                    .onTapGesture { open(room: m.room, thread: m.thread) }
                            }
                        }
                    }
                }
                .frame(maxHeight: 460)
            }
            Divider()
            HStack {
                Button("Open Agent Relay") { open() }
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
            }
        }
        .padding(12)
        .frame(width: 400)
        .onAppear { state.openMainWindowAction = { openWindow(id: "main") } }
    }

    private func open(room: String? = nil, thread: String? = nil) {
        state.openMainWindowAction = { openWindow(id: "main") }
        state.showMain(room: room, thread: thread)
    }
}
