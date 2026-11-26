import RelayKit
import SwiftUI

/// One task: status header, prompt, pending tool approvals, live event timeline
/// (polled every 2 s while visible), result, and the follow-up composer.
struct TaskDetailView: View {
    @EnvironmentObject var state: AppState
    let task: RelayTask
    @State private var events: [TaskEvent] = []
    @State private var eventsError: String?
    @State private var confirmCancel = false
    @State private var followUp = ""
    @State private var followUpError: String?

    private var machine: Machine? { state.machine(task.machine) }
    private var busy: Bool { state.busy.contains("task:\(task.id)") }

    var body: some View {
        ScrollViewReader { proxy in
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Color.clear.frame(height: 0).id("top")
                header
                promptBlock
                if !state.canSend { ReadOnlyNote() }
                let pending = task.pendingApprovals.filter { $0.status == .pending }
                if !pending.isEmpty {
                    ForEach(pending) { ToolApprovalCard(task: task, a: $0) }
                }
                if let e = task.error, !e.isEmpty {
                    Label { Text(verbatim: e).textSelection(.enabled) } icon: { Image(systemName: "exclamationmark.triangle.fill") }
                        .foregroundStyle(.red)
                        .font(.callout)
                }
                timeline
                if let r = task.result, !r.isEmpty { resultBlock(r) }
                if task.status.terminal { followUpComposer }
            }
            .padding(20)
            .frame(maxWidth: 820, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .onAppear {
            // The follow-up editor takes focus and scrolls itself into view; start at the top.
            for delay in [0.05, 0.3, 0.8] {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { proxy.scrollTo("top", anchor: .top) }
            }
        }
        }
        .background(Color(nsColor: .textBackgroundColor))
        // Restarts when the task leaves or re-enters a terminal state (a follow-up).
        .task(id: "\(task.id)|\(task.status.terminal)") { await poll() }
        .confirmationDialog("Cancel this task?", isPresented: $confirmCancel, titleVisibility: .visible) {
            Button("Cancel Task", role: .destructive) { Task { await state.cancelTask(task.id) } }
            Button("Keep Running", role: .cancel) {}
        } message: {
            Text(task.status == .queued || task.status == .awaitingTap
                 ? "It has not started; it is cancelled at once."
                 : "The worker on \(task.displayMachine) stops Claude Code and reports the task cancelled.")
        }
    }

    // MARK: header

    private var header: some View {
        HStack(alignment: .top, spacing: 14) {
            MachineIcon(machine: machine, size: 46)
            VStack(alignment: .leading, spacing: 6) {
                Text(verbatim: task.title)
                    .font(.title3.weight(.semibold))
                    .lineLimit(2)
                    .textSelection(.enabled)
                HStack(spacing: 6) {
                    TaskStatusChip(status: task.status, cancelRequested: task.cancelRequested)
                    PriorityChip(priority: task.priority)
                    Text(verbatim: task.displayMachine).font(.callout.weight(.medium))
                    MachineDot(machine: machine)
                }
                Label { Text(verbatim: task.folder).textSelection(.enabled) } icon: { Image(systemName: "folder") }
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(meta).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 8) {
                HStack(spacing: 6) {
                    if busy { ProgressView().controlSize(.small) }
                    if !task.status.terminal {
                        Button(role: .destructive) { confirmCancel = true } label: { Label("Cancel", systemImage: "stop.fill") }
                            .disabled(!state.canSend || busy || task.cancelRequested)
                    }
                    if task.status == .awaitingTap {
                        Button { Task { await state.startTask(task.id) } } label: { Label("Start", systemImage: "play.fill") }
                            .buttonStyle(.borderedProminent)
                            .tint(.orange)
                            .disabled(!state.canSend || busy || machine?.killed == true)
                            .help(machine?.killed == true ? "The machine is stopped by its kill switch." : "Let the worker pick it up")
                    }
                }
            }
        }
    }

    private var meta: String {
        var parts: [String] = []
        if let by = task.createdBy { parts.append("by \(by)") }
        if let src = task.sourceMachine { parts.append("from \(state.machineName(src))") }
        parts.append("created \(Fmt.when(task.createdAt))")
        if let d = Fmt.duration(from: task.startedAt, to: task.finishedAt) { parts.append("ran \(d)") }
        else if task.startedAt != nil, !task.status.terminal { parts.append("started \(Fmt.ago(task.startedAt))") }
        if let p = task.parent { parts.append("follows up \(p)") }
        return parts.joined(separator: " · ")
    }

    private var promptBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Prompt").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
            Text(verbatim: task.prompt)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.accentColor.opacity(0.12)))
        }
    }

    // MARK: timeline

    private var timeline: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("Activity").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                if !task.status.terminal {
                    ProgressView().controlSize(.mini)
                    Text("live").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if let eventsError { Text(eventsError).font(.caption).foregroundStyle(.red).lineLimit(1) }
            }
            if events.isEmpty {
                Text(task.status == .awaitingTap ? "Waits for your Start." : task.status == .queued ? "Waits for the worker on \(task.displayMachine)." : "No events yet.")
                    .font(.callout).foregroundStyle(.tertiary)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(events.enumerated()), id: \.element.id) { i, e in
                        EventRow(event: e, last: i == events.count - 1)
                    }
                }
            }
        }
    }

    private func resultBlock(_ r: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Result").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                if let code = task.exitCode {
                    StateLabel(text: "exit \(code)", symbol: code == 0 ? "checkmark" : "xmark", color: code == 0 ? .green : .red)
                }
                Spacer()
                Button { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(r, forType: .string) } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
                .controlSize(.small)
            }
            Text(verbatim: r)
                .font(.system(.callout, design: .monospaced))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.secondary.opacity(0.08)))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color(nsColor: .separatorColor)))
        }
    }

    // MARK: follow-up

    private var followUpComposer: some View {
        let allowed = machine?.policy.allowFollowUps ?? true
        let sending = state.busy.contains("followup:\(task.id)")
        return VStack(alignment: .leading, spacing: 6) {
            Text("Follow-up").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
            if !allowed {
                Label("Follow-ups are off in the policy of \(task.displayMachine).", systemImage: "lock")
                    .font(.callout).foregroundStyle(.secondary)
            } else {
                ZStack(alignment: .topLeading) {
                    TextEditor(text: $followUp)
                        .font(.body)
                        .scrollContentBackground(.hidden)
                        .padding(6)
                        .frame(minHeight: 70, maxHeight: 140)
                    if followUp.isEmpty {
                        Text("Continue this session: what should Claude do next?")
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 11)
                            .padding(.vertical, 6)
                            .allowsHitTesting(false)
                    }
                }
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color(nsColor: .controlBackgroundColor)))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color(nsColor: .separatorColor)))
                HStack {
                    if let followUpError {
                        Label(followUpError, systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(.red)
                    } else {
                        Text("Resumes the same Claude session in \(task.folder).").font(.caption).foregroundStyle(.secondary)
                            .lineLimit(1).truncationMode(.middle)
                    }
                    Spacer()
                    if sending { ProgressView().controlSize(.small) }
                    Button { send() } label: { Label("Send Follow-up", systemImage: "arrow.turn.down.right") }
                        .buttonStyle(.borderedProminent)
                        .keyboardShortcut(.return, modifiers: .command)
                        .disabled(!state.canSend || sending || followUp.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func send() {
        let p = followUp.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            switch await state.followUp(task.id, prompt: p) {
            case .success: followUp = ""; followUpError = nil
            case let .failure(e): followUpError = e.message
            }
        }
    }

    // MARK: polling

    private func poll() async {
        var refreshTick = 0
        while !Task.isCancelled {
            do {
                let fresh = try await state.taskEvents(task.id, after: events.last?.id)
                if !fresh.isEmpty {
                    let known = Set(events.map(\.id))
                    events += fresh.filter { !known.contains($0.id) }
                    events.sort { $0.id < $1.id }
                }
                eventsError = nil
                refreshTick += 1
                // Status, result and approvals live on the task: refresh it when something moved.
                if !state.fixtureMode, !fresh.isEmpty || refreshTick % 3 == 0, !(state.task(task.id)?.status.terminal ?? true) || !fresh.isEmpty {
                    await state.refreshTask(task.id)
                }
                // Finished and the timeline has caught up: nothing more will come, stop polling.
                if fresh.isEmpty, state.task(task.id)?.status.terminal ?? task.status.terminal { return }
            } catch {
                eventsError = (error as? RelayError)?.reason ?? error.localizedDescription
            }
            if state.fixtureMode { return }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
    }
}

/// One event on the timeline: a dot on a rail, the actor and time, the content.
struct EventRow: View {
    let event: TaskEvent
    var last = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(spacing: 0) {
                ZStack {
                    Circle().fill(color.opacity(0.16)).frame(width: 22, height: 22)
                    Image(systemName: symbol).font(.system(size: 10, weight: .semibold)).foregroundStyle(color)
                }
                if !last {
                    Rectangle().fill(Color(nsColor: .separatorColor)).frame(width: 1).frame(maxHeight: .infinity)
                }
            }
            .frame(width: 22)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(title).font(.callout.weight(.medium))
                    Text(verbatim: event.actor).font(.caption).foregroundStyle(.secondary)
                    Text(Fmt.when(event.at)).font(.caption).foregroundStyle(.tertiary).help(Fmt.stamp(event.at))
                }
                content
            }
            .padding(.bottom, last ? 0 : 12)
            Spacer(minLength: 0)
        }
    }

    private var d: JSONValue? { event.data }

    private var title: String {
        switch event.type {
        case "created": return "Created"
        case "started": return "Started"
        case "progress": return "Claude"
        case "tool": return d?["name"]?.string ?? "Tool"
        case "tool_result": return "\(d?["name"]?.string ?? "Tool") \(d?["ok"]?.bool == false ? "failed" : "ok")"
        case "finished": return "Finished"
        case "accepted": return "Accepted"
        case "status": return TaskEventText.status(d?["to"]?.string)
        case "followup": return "Follow-up"
        case "cancel_requested": return "Cancel requested"
        case "approval_requested": return "Approval requested"
        case "approval_decided": return "\(d?["tool"]?.string ?? "Tool") \(TaskEventText.decision(d?["status"]?.string))"
        case "expired": return "Expired"
        case "log": return "Log"
        default: return event.type.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    private var symbol: String {
        switch event.type {
        case "created": return "plus"
        case "queued", "start", "tapped": return "hand.tap"
        case "accepted": return "tray.and.arrow.down"
        case "started", "running": return "play.fill"
        case "progress": return "sparkles"
        case "tool": return "wrench.and.screwdriver"
        case "tool_result": return d?["ok"]?.bool == false ? "xmark" : "checkmark"
        case "finished", "done": return "flag.checkered"
        case "failed": return "xmark.octagon"
        case "cancelled", "cancel", "cancel_requested": return "stop.fill"
        case "log": return "text.alignleft"
        case "expired": return "hourglass"
        case "followup": return "arrowshape.turn.up.right"
        case "status": return TaskEventText.statusSymbol(d?["to"]?.string)
        case "approval_decided":
            return d?["status"]?.string == "approved" ? "checkmark.seal.fill" : d?["status"]?.string == "rejected" ? "xmark" : "hourglass"
        default:
            if event.type.contains("approv") { return "hand.raised.fill" }
            if event.type.contains("reject") { return "xmark" }
            return "circle.fill"
        }
    }

    private var color: Color {
        switch event.type {
        case "progress": return .accentColor
        case "tool": return (d?["category"]?.strings.isEmpty == false) ? .purple : .secondary
        case "tool_result": return d?["ok"]?.bool == false ? .red : .green
        case "finished", "done": return (d?["exitCode"]?.number ?? 0) == 0 ? .green : .red
        case "failed": return .red
        case "cancelled", "cancel", "cancel_requested", "expired": return .secondary
        case "status": return TaskEventText.statusColor(d?["to"]?.string)
        case "approval_decided":
            return d?["status"]?.string == "approved" ? .green : d?["status"]?.string == "rejected" ? .red : .secondary
        case "log": return d?["level"]?.string == "error" ? .red : .secondary
        default: return event.type.contains("approv") ? .purple : .teal
        }
    }

    @ViewBuilder private var content: some View {
        switch event.type {
        case "progress":
            if let t = d?["text"]?.string {
                Text(verbatim: t).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
        case "tool":
            VStack(alignment: .leading, spacing: 4) {
                if let input = d?["input"], !input.compact.isEmpty {
                    Text(verbatim: input["command"]?.string ?? input["file_path"]?.string ?? input["pattern"]?.string ?? input["url"]?.string ?? input.compact)
                        .font(.system(.caption, design: .monospaced))
                        .lineLimit(3)
                        .textSelection(.enabled)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(RoundedRectangle(cornerRadius: 5).fill(Color.secondary.opacity(0.08)))
                }
                let cats = d?["category"]?.strings ?? []
                if !cats.isEmpty {
                    HStack(spacing: 4) { ForEach(cats, id: \.self) { CategoryBadge(category: $0) } }
                }
            }
        case "finished":
            HStack(spacing: 6) {
                let code = Int(d?["exitCode"]?.number ?? 0)
                StateLabel(text: "exit \(code)", symbol: code == 0 ? "checkmark" : "xmark", color: code == 0 ? .green : .red)
                if let ms = d?["durationMs"]?.number { Text(Fmt.duration(ms: ms)).font(.caption).foregroundStyle(.secondary) }
                if let turns = d?["numTurns"]?.number { Text("\(Int(turns)) turns").font(.caption).foregroundStyle(.secondary) }
                if let cost = d?["costUsd"]?.number { Text(String(format: "$%.2f", cost)).font(.caption).foregroundStyle(.secondary) }
            }
        case "started":
            let bits = [d?["claudeVersion"]?.string.map { "Claude Code \($0)" }, d?["pid"]?.string.map { "pid \($0)" }].compactMap { $0 }
            if !bits.isEmpty { Text(bits.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary) }
        case "tool_result", "created", "accepted", "approval_decided":
            EmptyView()
        case "status":
            if let r = d?["reason"]?.string ?? d?["error"]?.string {
                Text(verbatim: r).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case "followup":
            if let child = d?["task"]?.string ?? d?["child"]?.string {
                Text(verbatim: child).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
            }
        default:
            let text = d?["text"]?.string ?? d?["summary"]?.string ?? d?["reason"]?.string ?? d?["error"]?.string
            if let text {
                Text(verbatim: text).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let d, d != .null, !d.compact.isEmpty, d.compact != "{}" {
                Text(verbatim: d.compact).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary).lineLimit(2)
            }
        }
    }
}

/// A tool call waiting for the owner: tool, categories, summary, countdown, Approve / Reject.
struct ToolApprovalCard: View {
    @EnvironmentObject var state: AppState
    let task: RelayTask
    let a: ToolApproval
    var showTask = false
    /// Menu bar popover: shorter summary.
    var compact = false

    var body: some View {
        let busy = state.busy.contains("tool:\(a.id)")
        Card(accent: .purple) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: "hand.raised.fill")
                    .font(.system(size: 22))
                    .foregroundStyle(.purple)
                    .frame(width: 32)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(verbatim: a.tool).font(.headline)
                        Text(verbatim: "on \(task.displayMachine)").font(.headline).foregroundStyle(.secondary)
                    }
                    Text(verbatim: showTask ? task.title : "A tool call of this task waits for you")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                ForEach(a.categories, id: \.self) { CategoryBadge(category: $0) }
                if let exp = a.expiresAt { Countdown(to: exp) }
            }
            Text(verbatim: a.summary)
                .font(.system(.callout, design: .monospaced))
                .textSelection(.enabled)
                .lineLimit(compact ? 4 : nil)
                .fixedSize(horizontal: false, vertical: true)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.secondary.opacity(0.08)))
            HStack {
                Label(task.folder, systemImage: "folder").font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                Spacer()
                Button(role: .destructive) { Task { await state.decideTool(task: task.id, approval: a.id, .reject) } } label: {
                    Label("Reject", systemImage: "xmark")
                }
                Button { Task { await state.decideTool(task: task.id, approval: a.id, .approve) } } label: {
                    Label("Approve", systemImage: "checkmark")
                }
                .buttonStyle(.borderedProminent)
                .tint(.purple)
            }
            .disabled(!state.canSend || busy)
        }
    }
}

/// A task that waits for the owner's Start.
struct TapTaskCard: View {
    @EnvironmentObject var state: AppState
    let task: RelayTask
    /// Menu bar popover: shorter prompt.
    var compact = false
    @State private var confirmCancel = false

    var body: some View {
        let busy = state.busy.contains("task:\(task.id)")
        let machine = state.machine(task.machine)
        Card(accent: .orange) {
            HStack(alignment: .center, spacing: 10) {
                MachineIcon(machine: machine, size: 32)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(verbatim: task.displayMachine).font(.headline)
                        Text(verbatim: task.folder).font(.headline).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    }
                    Text("By \(task.createdBy ?? "console") · \(Fmt.ago(task.createdAt))").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                PriorityChip(priority: task.priority)
                TaskStatusChip(status: task.status)
            }
            Text(verbatim: task.prompt)
                .textSelection(.enabled)
                .lineLimit(compact ? 3 : 6)
                .fixedSize(horizontal: false, vertical: true)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.secondary.opacity(0.08)))
            HStack {
                Button { state.focusTask = task.id; state.showMain(section: .tasks) } label: { Label("Open", systemImage: "arrow.up.right") }
                    .buttonStyle(.link)
                Spacer()
                Button(role: .destructive) { confirmCancel = true } label: { Label("Cancel", systemImage: "xmark") }
                Button { Task { await state.startTask(task.id) } } label: { Label("Start", systemImage: "play.fill") }
                    .buttonStyle(.borderedProminent)
                    .tint(.orange)
                    .disabled(machine?.killed == true)
            }
            .disabled(!state.canSend || busy)
        }
        .confirmationDialog("Cancel this task?", isPresented: $confirmCancel, titleVisibility: .visible) {
            Button("Cancel Task", role: .destructive) { Task { await state.cancelTask(task.id) } }
            Button("Keep", role: .cancel) {}
        } message: {
            Text("It has not started; it is cancelled at once.")
        }
    }
}

/// Wording for the event types the relay writes (status, approval_decided).
enum TaskEventText {
    static func status(_ to: String?) -> String {
        guard let to else { return "changed" }
        return TaskStatus(rawValue: to)?.title ?? to.replacingOccurrences(of: "_", with: " ")
    }

    static func decision(_ s: String?) -> String {
        switch s {
        case "approved": return "approved"
        case "rejected": return "rejected"
        case "expired": return "expired"
        default: return "decided"
        }
    }

    static func statusSymbol(_ to: String?) -> String {
        switch to {
        case "running": return "play.fill"
        case "done": return "flag.checkered"
        case "failed": return "xmark.octagon"
        case "cancelled": return "stop.fill"
        case "awaiting_tap": return "hand.tap"
        case "waiting_approval": return "hand.raised.fill"
        default: return "arrow.right"
        }
    }

    static func statusColor(_ to: String?) -> Color {
        switch to {
        case "done": return .green
        case "failed": return .red
        case "waiting_approval": return .purple
        case "cancelled": return .secondary
        default: return .teal
        }
    }
}
