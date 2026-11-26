import RelayKit
import SwiftUI

enum ApprovalsMode: String, CaseIterable, Identifiable {
    case waiting = "Waiting"
    case history = "History"
    var id: String { rawValue }
}

/// Everything that waits for the owner: held posts of my agents (to rooms shared
/// with other people), action approvals, task taps and tool approvals. History lists
/// decided approvals. Cmd+Return sends or approves the selected card, Cmd+Delete rejects it.
struct ApprovalsView: View {
    @EnvironmentObject var state: AppState
    @State private var mode = ApprovalsMode.waiting
    @State private var selected: String?
    @State private var confirmBig: OwnerApproval?
    @State private var confirmCancelTap: RelayTask?

    var body: some View {
        Group {
            if mode == .history { ApprovalHistoryView() } else { waiting }
        }
        .navigationTitle("Approvals")
        .navigationSubtitle(state.teamFilter == .all ? "" : state.filterTitle)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("Show", selection: $mode) {
                    ForEach(ApprovalsMode.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .help("Waiting items or decided approvals")
            }
        }
    }

    /// Selection keys in display order: "post:id", "approval:id", "tap:id", "tool:id".
    private var keys: [String] {
        state.filteredPosts.map { "post:\($0.id)" } + state.filteredApprovals.map { "approval:\($0.id)" }
            + state.tasksAwaitingTap.map { "tap:\($0.id)" } + state.pendingToolApprovals.map { "tool:\($0.approval.id)" }
    }

    private var current: String? {
        let k = keys
        if let selected, k.contains(selected) { return selected }
        return k.first
    }

    private var waiting: some View {
        let posts = state.filteredPosts
        let approvals = state.filteredApprovals
        let taps = state.tasksAwaitingTap
        let tools = state.pendingToolApprovals
        return Group {
            if posts.isEmpty && approvals.isEmpty && taps.isEmpty && tools.isEmpty {
                EmptyState("Nothing waits for you", symbol: "checkmark.seal",
                           message: "Held posts, action approvals and tasks for your machines show up here.")
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        if !state.canSend { ReadOnlyNote() }
                        if !posts.isEmpty {
                            SectionHeader("Held posts", count: posts.count, symbol: "paperplane",
                                          note: "Your agents posted to rooms shared with other people. Nothing is sent until you press Send.")
                            ForEach(posts) { p in selectable("post:\(p.id)") { PostCard(post: p) } }
                        }
                        if !approvals.isEmpty {
                            SectionHeader("Action approvals", count: approvals.count, symbol: "checkmark.shield",
                                          note: "Your agents ask before a risky action.")
                            ForEach(approvals) { a in selectable("approval:\(a.id)") { ApprovalCard(a: a) } }
                        }
                        if !taps.isEmpty {
                            SectionHeader("Tasks to start", count: taps.count, symbol: "hand.tap",
                                          note: "Tasks for your machines whose policy asks for a tap. The worker waits for Start.")
                            ForEach(taps) { t in selectable("tap:\(t.id)") { TapTaskCard(task: t) } }
                        }
                        if !tools.isEmpty {
                            SectionHeader("Tool approvals", count: tools.count, symbol: "exclamationmark.shield",
                                          note: "Claude Code on your machines wants to run a tool your policy holds for approval.")
                            ForEach(tools, id: \.approval.id) { x in
                                selectable("tool:\(x.approval.id)") { ToolApprovalCard(task: x.task, a: x.approval, showTask: true) }
                            }
                        }
                        if state.canSend {
                            Text("⌘↩ sends or approves the selected item, ⌘⌫ rejects it.")
                                .font(.caption).foregroundStyle(.tertiary)
                        }
                    }
                    .padding(20)
                    .frame(maxWidth: 860, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .background {
            Group {
                Button("Approve Selected") { primary() }.keyboardShortcut(.return, modifiers: .command)
                Button("Reject Selected") { secondary() }.keyboardShortcut(.delete, modifiers: .command)
            }
            .opacity(0)
            .frame(width: 0, height: 0)
            .disabled(!state.canSend || current == nil)
            .accessibilityHidden(true)
        }
        .confirmationDialog("Approve \(confirmBig?.action ?? "")?", isPresented: Binding(get: { confirmBig != nil }, set: { if !$0 { confirmBig = nil } }), titleVisibility: .visible) {
            Button("Approve \(confirmBig?.action ?? "")", role: .destructive) {
                if let a = confirmBig { Task { await state.decideApproval(a.id, .approve) } }
                confirmBig = nil
            }
            Button("Cancel", role: .cancel) { confirmBig = nil }
        } message: {
            Text(ApprovalCard.bigWarning(confirmBig))
        }
        .confirmationDialog("Cancel this task?", isPresented: Binding(get: { confirmCancelTap != nil }, set: { if !$0 { confirmCancelTap = nil } }), titleVisibility: .visible) {
            Button("Cancel Task", role: .destructive) {
                if let t = confirmCancelTap { Task { await state.cancelTask(t.id) } }
                confirmCancelTap = nil
            }
            Button("Keep", role: .cancel) { confirmCancelTap = nil }
        } message: {
            Text("It has not started; it is cancelled at once.")
        }
    }

    private func selectable<C: View>(_ key: String, @ViewBuilder _ card: () -> C) -> some View {
        let on = current == key
        return card()
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color.accentColor, lineWidth: 2).opacity(on ? 1 : 0))
            .simultaneousGesture(TapGesture().onEnded { selected = key })
            .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func split(_ key: String) -> (String, String) {
        let parts = key.split(separator: ":", maxSplits: 1).map(String.init)
        return (parts.first ?? "", parts.count > 1 ? parts[1] : "")
    }

    /// Cmd+Return: Send / Approve / Start.
    private func primary() {
        guard let key = current else { return }
        let (kind, id) = split(key)
        switch kind {
        case "post": if let n = Int(id) { Task { await state.decidePost(n, .approve) } }
        case "approval":
            guard let a = state.filteredApprovals.first(where: { $0.id == id }) else { return }
            if a.tier == .big { confirmBig = a } else { Task { await state.decideApproval(id, .approve) } }
        case "tap":
            if state.machine(state.task(id)?.machine)?.killed != true { Task { await state.startTask(id) } }
        case "tool":
            if let x = state.pendingToolApprovals.first(where: { $0.approval.id == id }) {
                Task { await state.decideTool(task: x.task.id, approval: id, .approve) }
            }
        default: break
        }
    }

    /// Cmd+Delete: Reject (a waiting task is cancelled after a confirmation).
    private func secondary() {
        guard let key = current else { return }
        let (kind, id) = split(key)
        switch kind {
        case "post": if let n = Int(id) { Task { await state.decidePost(n, .reject) } }
        case "approval": Task { await state.decideApproval(id, .reject) }
        case "tap": confirmCancelTap = state.task(id)
        case "tool":
            if let x = state.pendingToolApprovals.first(where: { $0.approval.id == id }) {
                Task { await state.decideTool(task: x.task.id, approval: id, .reject) }
            }
        default: break
        }
    }
}

/// Decided approvals from `GET /owner/approvals`: who decided, how and when.
struct ApprovalHistoryView: View {
    @EnvironmentObject var state: AppState
    @State private var rows: [OwnerApproval] = []
    @State private var error: String?
    @State private var loaded = false

    var body: some View {
        VStack(spacing: 0) {
            if let error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).padding(8) }
            Table(rows) {
                TableColumn("Action") { a in
                    Label(a.action, systemImage: a.tier == .big ? "exclamationmark.shield.fill" : "checkmark.shield")
                        .help(a.summary)
                }.width(min: 120, ideal: 180)
                TableColumn("Project") { Text(verbatim: $0.project).foregroundStyle(.secondary) }.width(min: 70, ideal: 120)
                TableColumn("Tier") { TierLabel(tier: $0.tier) }.width(70)
                TableColumn("Decision") { a in
                    Text(a.status.rawValue.capitalized)
                        .foregroundStyle(a.status == .approved ? Color.green : a.status == .rejected ? Color.red : Color.secondary)
                }.width(80)
                TableColumn("Decided by") { a in
                    Text(verbatim: [a.decidedBy, a.decidedVia.map { "via \($0)" }].compactMap { $0 }.joined(separator: " "))
                        .foregroundStyle(.secondary)
                }.width(min: 90, ideal: 150)
                TableColumn("Decided") { a in
                    Text(a.decidedAt.map { Fmt.when($0) } ?? "").monospacedDigit().help(Fmt.stamp(a.decidedAt))
                }.width(min: 70, ideal: 110)
                TableColumn("Asked by") { Text(verbatim: $0.requester).foregroundStyle(.secondary) }.width(min: 70, ideal: 120)
            }
            .overlay {
                if rows.isEmpty {
                    if !loaded { ProgressView() } else if error == nil {
                        EmptyState("No decided approvals", symbol: "clock",
                                   message: "Approvals you or your team decided show up here.")
                    }
                }
            }
        }
        .toolbar {
            ToolbarItem {
                Button { Task { await load() } } label: { Label("Reload", systemImage: "arrow.clockwise") }
                    .help("Reload (⌘R)")
            }
        }
        .task(id: "\(state.refreshToken)|\(state.summary.pendingApprovals)") { await load() }
    }

    private func load() async {
        defer { loaded = true }
        guard let c = state.client else { return }
        do {
            rows = try await c.approvals(limit: 100).approvals
                .filter { $0.status != .pending }
                .sorted { ($0.decidedAt ?? $0.createdAt) > ($1.decidedAt ?? $1.createdAt) }
            error = nil
        } catch {
            self.error = (error as? RelayError)?.reason ?? error.localizedDescription
        }
    }
}

struct SectionHeader: View {
    let title: String
    let count: Int
    let symbol: String
    var note: String?

    init(_ title: String, count: Int, symbol: String, note: String? = nil) {
        self.title = title
        self.count = count
        self.symbol = symbol
        self.note = note
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Label(title, systemImage: symbol).font(.title3.weight(.semibold))
                Text("\(count)")
                    .font(.callout.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7)
                    .background(Capsule().fill(Color.secondary.opacity(0.15)))
            }
            if let note { Text(note).font(.callout).foregroundStyle(.secondary) }
        }
    }
}

struct Card<Content: View>: View {
    var accent: Color?
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color(nsColor: .controlBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color(nsColor: .separatorColor)))
            .overlay(alignment: .leading) {
                if let accent {
                    UnevenAccent().fill(accent).frame(width: 4)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

/// A plain bar; the card's clip rounds its corners.
struct UnevenAccent: Shape {
    func path(in rect: CGRect) -> Path { Path(rect) }
}

struct Countdown: View {
    let to: String
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            Label(Fmt.countdown(to: to, now: ctx.date), systemImage: "timer")
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
        .help("Expires \(Fmt.stamp(to))")
    }
}

struct PostCard: View {
    @EnvironmentObject var state: AppState
    let post: ConsoleMessage
    var compact = false

    var body: some View {
        let room = state.room(post.room)
        Card(accent: .orange) {
            HStack(alignment: .center, spacing: 10) {
                AgentAvatar(owner: post.owner, ownerName: post.ownerName, agent: post.from, size: compact ? 24 : 32)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 4) {
                        Text(verbatim: post.from).font(.headline)
                        Image(systemName: "arrow.right").font(.caption).foregroundStyle(.tertiary)
                        Text(verbatim: room?.title.nilIfEmpty ?? post.room).font(.headline)
                        Text(verbatim: "/ \(post.thread)").font(.headline).foregroundStyle(.secondary)
                    }
                    .lineLimit(1)
                    if let t = room?.teamName {
                        Label(t, systemImage: "person.3").font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                StatusLabel(status: .pending)
                if let exp = post.expiresAt { Countdown(to: exp) }
            }
            Text(verbatim: post.text)
                .textSelection(.enabled)
                .lineLimit(compact ? 4 : nil)
                .fixedSize(horizontal: false, vertical: true)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.secondary.opacity(0.08)))
            HStack {
                let seen = post.seenBy ?? []
                if !seen.isEmpty {
                    Label("Will be seen by \(seen.joined(separator: ", "))", systemImage: "eye")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                PostButtons(id: post.id, small: compact)
            }
        }
    }
}

struct ApprovalCard: View {
    @EnvironmentObject var state: AppState
    let a: OwnerApproval
    var compact = false
    @State private var confirmBig = false

    static func bigWarning(_ a: OwnerApproval?) -> String {
        guard let a else { return "" }
        return "This is a big-tier action in \(a.project): \(a.summary)\nThe agent runs it as soon as you approve."
    }

    var body: some View {
        let busy = state.busy.contains("approval:\(a.id)")
        Card(accent: a.tier == .big ? .red : .blue) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: a.tier == .big ? "exclamationmark.shield.fill" : "checkmark.shield")
                    .font(.system(size: compact ? 18 : 24))
                    .foregroundStyle(a.tier == .big ? Color.red : Color.blue)
                    .frame(width: compact ? 24 : 32)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(a.action).font(.headline)
                        Text("in \(a.project)").font(.headline).foregroundStyle(.secondary)
                    }
                    Text("Asked by \(a.requester) · scope \(a.scope)").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                TierLabel(tier: a.tier)
                Countdown(to: a.expiresAt)
            }
            Text(verbatim: a.summary)
                .font(.body.weight(.medium))
                .textSelection(.enabled)
                .lineLimit(compact ? 3 : nil)
                .fixedSize(horizontal: false, vertical: true)
            if !compact {
                let fx: [(String, String?)] = [("Diff", a.effect.diff), ("To", a.effect.recipient), ("Amount", a.effect.amount), ("Details", a.effect.details)]
                let rows = fx.filter { $0.1 != nil }
                if !rows.isEmpty {
                    Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 6) {
                        ForEach(rows, id: \.0) { item in
                            GridRow {
                                Text(item.0).font(.callout).foregroundStyle(.secondary).gridColumnAlignment(.trailing)
                                Text(verbatim: item.1 ?? "").font(.callout).textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.secondary.opacity(0.08)))
                }
            }
            HStack {
                Spacer()
                Button(role: .destructive) { Task { await state.decideApproval(a.id, .reject) } } label: {
                    Label("Reject", systemImage: "xmark")
                }
                Button {
                    if a.tier == .big { confirmBig = true } else { Task { await state.decideApproval(a.id, .approve) } }
                } label: {
                    Label("Approve \(a.action)", systemImage: "checkmark")
                }
                .buttonStyle(.borderedProminent)
                .tint(a.tier == .big ? .red : .accentColor)
            }
            .controlSize(compact ? .small : .regular)
            .disabled(!state.canSend || busy)
        }
        .confirmationDialog("Approve \(a.action)?", isPresented: $confirmBig, titleVisibility: .visible) {
            Button("Approve \(a.action)", role: .destructive) { Task { await state.decideApproval(a.id, .approve) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(Self.bigWarning(a))
        }
    }
}
