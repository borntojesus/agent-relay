import RelayKit
import SwiftUI

/// Tasks on my machines: list with filters on the left, the selected task on the right.
struct TasksView: View {
    @EnvironmentObject var state: AppState
    @State private var machineFilter = ""
    @State private var statusFilter = ""

    private var shown: [RelayTask] {
        state.tasks.filter { t in
            (machineFilter.isEmpty || t.machine == machineFilter)
                && (statusFilter.isEmpty || statusFilter == "active" && !t.status.terminal || t.status.rawValue == statusFilter)
        }
    }

    var body: some View {
        HStack(spacing: 0) {
            list.frame(width: 340)
            Divider()
            Group {
                if let t = state.task(state.focusTask) {
                    TaskDetailView(task: t).id(t.id)
                } else {
                    EmptyState("No task selected", symbol: "checklist",
                               message: "Pick a task to follow it live, or start a new one on one of your machines.")
                }
            }
            .frame(minWidth: 380, maxWidth: .infinity, maxHeight: .infinity)
        }
        .navigationTitle("Tasks")
        .navigationSubtitle(subtitle)
        .toolbar {
            ToolbarItemGroup {
                Picker("Machine", selection: $machineFilter) {
                    Text("All machines").tag("")
                    Divider()
                    ForEach(state.machines) { m in Text(verbatim: m.name).tag(m.id) }
                }
                .frame(width: 150)
                .help("Show one machine")
                Picker("Status", selection: $statusFilter) {
                    Text("Any status").tag("")
                    Text("Active").tag("active")
                    Divider()
                    ForEach(TaskStatus.allCases, id: \.self) { s in Text(s.title).tag(s.rawValue) }
                }
                .frame(width: 140)
                .help("Show one status")
                Button { state.showNewTask = true } label: {
                    Label("New Task", systemImage: "plus")
                }
                .help("Start a Claude Code task on one of your machines (⌘N)")
                .disabled(!state.canSend || state.machines.isEmpty)
            }
        }
        .sheet(isPresented: $state.showNewTask) {
            NewTaskSheet().environmentObject(state)
        }
    }

    private var subtitle: String {
        let active = state.tasks.filter { !$0.status.terminal }.count
        return active > 0 ? "\(active) active" : "\(state.tasks.count) tasks"
    }

    @ViewBuilder private var list: some View {
        let ts = shown
        if ts.isEmpty {
            EmptyState(state.tasks.isEmpty ? "No tasks yet" : "No matching tasks", symbol: "checklist",
                       message: state.tasks.isEmpty
                           ? (state.machines.isEmpty ? "Add a machine with `relay machine add`, then start a task here."
                               : "Press + to send a task to one of your machines.")
                           : "Change the machine or status filter.")
        } else {
            List(selection: $state.focusTask) {
                ForEach(ts) { TaskRow(task: $0).tag($0.id) }
            }
            .listStyle(.inset)
        }
    }
}

struct TaskRow: View {
    @EnvironmentObject var state: AppState
    let task: RelayTask

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            MachineIcon(machine: state.machine(task.machine), size: 30)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(verbatim: task.title)
                        .font(.body.weight(task.status.terminal ? .regular : .semibold))
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(Fmt.ago(task.createdAt))
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .help(Fmt.stamp(task.createdAt))
                }
                HStack(spacing: 4) {
                    Text(verbatim: task.displayMachine).foregroundStyle(.secondary)
                    Text("·").foregroundStyle(.tertiary)
                    Text(verbatim: shortFolder).foregroundStyle(.secondary).truncationMode(.head)
                }
                .font(.caption)
                .lineLimit(1)
                HStack(spacing: 4) {
                    TaskStatusChip(status: task.status, cancelRequested: task.cancelRequested)
                    PriorityChip(priority: task.priority)
                    if task.parent != nil {
                        Image(systemName: "arrowshape.turn.up.right").font(.caption2).foregroundStyle(.secondary)
                            .help("Follow-up of \(task.parent ?? "")")
                    }
                    if !task.pendingApprovals.filter({ $0.status == .pending }).isEmpty {
                        Image(systemName: "exclamationmark.shield.fill").font(.caption).foregroundStyle(.purple)
                            .help("A tool call waits for your approval")
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    /// The folder relative to the home directory when it is inside one.
    private var shortFolder: String {
        let f = task.folder
        if let r = f.range(of: #"^/Users/[^/]+"#, options: .regularExpression) { return "~" + f[r.upperBound...] }
        if let r = f.range(of: #"^/home/[^/]+"#, options: .regularExpression) { return "~" + f[r.upperBound...] }
        return f
    }
}
