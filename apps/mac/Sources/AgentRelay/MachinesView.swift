import AppKit
import RelayKit
import SwiftUI

/// My machines: who is online, what they run, the kill switch and the policy.
struct MachinesView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        HStack(spacing: 0) {
            Group {
                if state.machines.isEmpty {
                    EmptyState("No machines", symbol: "laptopcomputer.and.iphone",
                               message: "Add one with `relay machine add`, then run the worker on it.")
                } else {
                    List(selection: $state.focusMachine) {
                        ForEach(state.machines) { MachineRow(machine: $0).tag($0.id) }
                    }
                    .listStyle(.inset)
                }
            }
            .frame(width: 280)
            Divider()
            Group {
                if let m = state.machine(state.focusMachine) {
                    MachineDetail(machine: m).id(m.id)
                } else {
                    EmptyState("No machine selected", symbol: "laptopcomputer",
                               message: "Pick a machine to see its tasks, stop it, or edit what it may do.")
                }
            }
            .frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
        }
        .navigationTitle("Machines")
        .navigationSubtitle("\(state.machines.filter(\.online).count) of \(state.machines.count) online")
        .toolbar {
            ToolbarItemGroup {
                Button { Task { await state.reloadMachines() } } label: { Label("Reload", systemImage: "arrow.clockwise") }
                    .help("Reload machines")
            }
        }
        .onAppear {
            if state.focusMachine == nil { state.focusMachine = state.machines.first?.id }
        }
    }
}

struct MachineRow: View {
    let machine: Machine

    var body: some View {
        HStack(spacing: 10) {
            MachineIcon(machine: machine, size: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: machine.name).font(.body.weight(.medium)).lineLimit(1)
                Text(status).font(.caption).foregroundStyle(machine.killed ? Color.red : Color.secondary).lineLimit(1)
            }
            Spacer(minLength: 4)
            if machine.running > 0 {
                StateLabel(text: "\(machine.running)", symbol: "play.fill", color: .blue).help("Running")
            }
            if machine.queued > 0 {
                StateLabel(text: "\(machine.queued)", symbol: "clock", color: .indigo).help("Queued")
            }
        }
        .padding(.vertical, 3)
    }

    private var status: String {
        if machine.killed { return "Stopped by kill switch" }
        return machine.online ? "Online" : "Last seen \(Fmt.ago(machine.lastSeen))"
    }
}

struct MachineDetail: View {
    @EnvironmentObject var state: AppState
    let machine: Machine
    @State private var renaming = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .center, spacing: 14) {
                MachineIcon(machine: machine, size: 46)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(verbatim: machine.name).font(.title2.weight(.semibold))
                        if state.canSend {
                            Button { renaming = true } label: { Image(systemName: "pencil") }
                                .buttonStyle(.borderless)
                                .help("Rename \(machine.name)")
                                .accessibilityLabel("Rename machine")
                        }
                    }
                    HStack(spacing: 6) {
                        MachineDot(machine: machine)
                        Text(machine.killed ? "Stopped" : machine.online ? "Online" : "Offline").font(.callout)
                        Text("·").foregroundStyle(.tertiary)
                        Text(verbatim: machine.id).font(.system(.callout, design: .monospaced)).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Picker("View", selection: $state.machineTab) {
                    ForEach(MachineTab.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 180)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
            Divider()
            switch state.machineTab {
            case .overview: MachineOverview(machine: machine)
            case .policy: PolicyEditor(machine: machine).id(machine.id)
            }
        }
        .sheet(isPresented: $renaming) { RenameMachineSheet(machine: machine) }
    }
}

/// PATCH /owner/machines/:id {name}. The id stays; only the display name changes.
struct RenameMachineSheet: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    let machine: Machine
    @State private var name = ""
    @State private var error: String?

    var body: some View {
        let busy = state.busy.contains("machine:\(machine.id)")
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        VStack(alignment: .leading, spacing: 12) {
            Text("Rename machine").font(.headline)
            TextField("Name", text: $name)
                .textFieldStyle(.roundedBorder)
                .onSubmit { save(trimmed) }
            Text("The id \(machine.id) stays the same; workers keep working.").font(.caption).foregroundStyle(.secondary)
            if let error { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.caption) }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Rename") { save(trimmed) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(trimmed.isEmpty || trimmed == machine.name || busy)
            }
        }
        .padding(20)
        .frame(width: 360)
        .onAppear { name = machine.name }
    }

    private func save(_ n: String) {
        guard !n.isEmpty, n != machine.name else { return }
        Task {
            error = await state.updateMachine(machine.id, name: n)
            if error == nil { dismiss() }
        }
    }
}

struct MachineOverview: View {
    @EnvironmentObject var state: AppState
    let machine: Machine
    @State private var confirmKill = false
    @State private var error: String?

    var body: some View {
        let busy = state.busy.contains("machine:\(machine.id)")
        let tasks = state.tasks.filter { $0.machine == machine.id }
        Form {
            Section {
                LabeledContent("Status") {
                    HStack(spacing: 6) {
                        MachineDot(machine: machine)
                        Text(machine.killed ? "Stopped" : machine.online ? "Online" : "Offline")
                    }
                }
                LabeledContent("Last seen") { Text(machine.online ? "Now" : Fmt.when(machine.lastSeen)).help(Fmt.stamp(machine.lastSeen)) }
                LabeledContent("Worker") { Text(verbatim: machine.workerVersion ?? "Not connected yet").foregroundStyle(.secondary) }
                LabeledContent("Running") { Text("\(machine.running)").monospacedDigit() }
                LabeledContent("Queued") { Text("\(machine.queued)").monospacedDigit() }
            }
            Section {
                Toggle(isOn: Binding(get: { machine.killed }, set: { _ in confirmKill = true })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Kill switch").font(.body.weight(.medium))
                        Text(machine.killed
                             ? "On: the worker stops running tasks and new ones are refused."
                             : "Stops what runs now and refuses new tasks until you turn it off.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                .toggleStyle(.switch)
                .tint(.red)
                .disabled(!state.canSend || busy)
                if let error { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.caption) }
            } header: {
                Text("Safety")
            }
            Section {
                if tasks.isEmpty {
                    Text("No recent tasks.").foregroundStyle(.secondary)
                } else {
                    ForEach(tasks.prefix(8)) { t in
                        Button { state.focusTask = t.id; state.selection = .tasks } label: {
                            HStack(spacing: 8) {
                                TaskStatusChip(status: t.status, cancelRequested: t.cancelRequested)
                                Text(verbatim: t.title).lineLimit(1)
                                Spacer()
                                Text(Fmt.ago(t.createdAt)).font(.caption).foregroundStyle(.tertiary)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            } header: {
                HStack {
                    Text("Recent tasks")
                    Spacer()
                    Button("New Task") { state.focusMachine = machine.id; state.selection = .tasks; state.showNewTask = true }
                        .controlSize(.small)
                        .disabled(!state.canSend || machine.killed)
                }
            }
        }
        .formStyle(.grouped)
        .confirmationDialog(machine.killed ? "Turn the kill switch off?" : "Stop \(machine.name)?",
                            isPresented: $confirmKill, titleVisibility: .visible) {
            if machine.killed {
                Button("Turn Off") { toggle(false) }
            } else {
                Button("Stop Machine", role: .destructive) { toggle(true) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(machine.killed
                 ? "The worker on \(machine.name) picks up tasks again."
                 : "Running tasks on \(machine.name) are stopped and new tasks are refused until you turn it off.")
        }
    }

    private func toggle(_ on: Bool) {
        Task { error = await state.updateMachine(machine.id, killed: on) }
    }
}

/// The policy of one machine. Save sends the whole policy (PATCH); the relay's 400 reason shows inline.
struct PolicyEditor: View {
    @EnvironmentObject var state: AppState
    let machine: Machine
    @State private var draft: MachinePolicy
    /// The server policy the draft started from. A poll never touches the draft by itself.
    @State private var base: MachinePolicy
    @State private var serverChanged = false
    @State private var saving = false
    @State private var newFolder = ""
    @State private var error: String?
    @State private var saved = false

    init(machine: Machine) {
        self.machine = machine
        _draft = State(initialValue: machine.policy)
        _base = State(initialValue: machine.policy)
    }

    private var dirty: Bool { draft != base }
    private var folderInput: String { newFolder.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        let busy = state.busy.contains("machine:\(machine.id)")
        let ro = !state.canSend
        VStack(spacing: 0) {
            Form {
                Section {
                    if draft.folders.isEmpty {
                        Text("No folders: every task is refused.").foregroundStyle(.orange)
                    }
                    ForEach(Array(draft.folders.enumerated()), id: \.offset) { i, f in
                        HStack {
                            Image(systemName: "folder").foregroundStyle(.secondary)
                            Text(verbatim: f).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                            Spacer()
                            if !ro {
                                Button { draft.folders.remove(at: i) } label: { Image(systemName: "minus.circle.fill") }
                                    .buttonStyle(.plain).foregroundStyle(.red).help("Remove")
                            }
                        }
                    }
                    if !ro {
                        HStack {
                            TextField("Path on \(machine.name), e.g. /home/me/project", text: $newFolder)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(.body, design: .monospaced))
                                .onSubmit { addTyped() }
                            Button("Add") { addTyped() }
                                .disabled(!folderInput.hasPrefix("/") || draft.folders.contains(folderInput))
                                .help("Add the typed absolute path")
                            Button { pickFolder() } label: { Label("Choose...", systemImage: "folder.badge.plus") }
                                .help("Pick a folder on this Mac")
                        }
                        if !folderInput.isEmpty && !folderInput.hasPrefix("/") {
                            Text("Use an absolute path starting with /.").font(.caption).foregroundStyle(.orange)
                        }
                    }
                } header: {
                    Text("Folders")
                } footer: {
                    Text("Tasks run only inside these folders on \(machine.name). Paths are on that machine.").frame(maxWidth: .infinity, alignment: .leading)
                }

                Section("Claude Code") {
                    Picker("Permission mode", selection: $draft.permissionMode) {
                        Text("Default").tag(PermissionMode.default)
                        Text("Accept edits").tag(PermissionMode.acceptEdits)
                        Text("Plan only").tag(PermissionMode.plan)
                    }
                    Stepper(value: $draft.maxRuntimeMinutes, in: 1...240) {
                        LabeledContent("Max runtime") { Text("\(draft.maxRuntimeMinutes) min").monospacedDigit() }
                    }
                    Toggle("Allow follow-ups", isOn: $draft.allowFollowUps)
                    Toggle(isOn: $draft.requireTap) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Require a tap to start")
                            Text("Tasks wait in Approvals until you press Start.").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }

                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Allowed")
                        TokenListEditor(tokens: $draft.allowedTools, placeholder: "Read, Edit, Bash(pnpm test:*)", color: .green, disabled: ro)
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Disallowed")
                        TokenListEditor(tokens: $draft.disallowedTools, placeholder: "Bash(rm:*)", color: .red, disabled: ro)
                    }
                } header: {
                    Text("Tools")
                } footer: {
                    Text("Claude Code tool rules, passed to --allowedTools and --disallowedTools.").frame(maxWidth: .infinity, alignment: .leading)
                }

                Section {
                    HStack(spacing: 14) {
                        ForEach(ApprovalAction.allCases, id: \.self) { a in
                            Toggle(isOn: Binding(
                                get: { draft.approvalActions.contains(a.rawValue) },
                                set: { on in
                                    if on { if !draft.approvalActions.contains(a.rawValue) { draft.approvalActions.append(a.rawValue) } }
                                    else { draft.approvalActions.removeAll { $0 == a.rawValue } }
                                })) {
                                Label(a.rawValue, systemImage: Category.symbol(a.rawValue))
                            }
                            .toggleStyle(.checkbox)
                        }
                    }
                } header: {
                    Text("Ask before")
                } footer: {
                    Text("Tool calls in these categories wait for your Approve, here and on Telegram.").frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .formStyle(.grouped)
            .disabled(ro || busy)
            if serverChanged {
                Divider()
                HStack(spacing: 8) {
                    Label("The policy was changed elsewhere while you were editing.", systemImage: "arrow.triangle.2.circlepath")
                        .font(.callout)
                    Spacer()
                    Button("Load Server Version") { draft = machine.policy; base = machine.policy; serverChanged = false; error = nil }
                    Button("Keep Mine") { base = machine.policy; serverChanged = false }
                        .help("Keep your edits; Save overwrites the server version")
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
                .background(Color.yellow.opacity(0.12))
            }
            Divider()
            HStack(spacing: 8) {
                if let error {
                    Label(error, systemImage: "exclamationmark.octagon.fill").foregroundStyle(.red).font(.callout)
                        .textSelection(.enabled).lineLimit(3)
                } else if saved && !dirty {
                    Label("Saved", systemImage: "checkmark.circle.fill").foregroundStyle(.green).font(.callout)
                } else if dirty {
                    Text("Unsaved changes").font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                if busy { ProgressView().controlSize(.small) }
                Button("Revert") { draft = machine.policy; base = machine.policy; serverChanged = false; error = nil }
                    .disabled((!dirty && !serverChanged) || busy)
                Button("Save") { save() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut("s", modifiers: .command)
                    .disabled(!dirty || busy || ro)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 10)
        }
        .onChange(of: machine.policy) { fresh in serverPolicyChanged(fresh) }
    }

    /// A poll brought a new server policy. Never clobber unsaved edits.
    private func serverPolicyChanged(_ fresh: MachinePolicy) {
        if saving || !dirty || fresh == draft {
            // Our own save, nothing edited, or the server now equals the draft: adopt silently.
            if saving || !dirty { draft = fresh }
            base = fresh
            serverChanged = false
        } else if fresh != base {
            serverChanged = true
        }
    }

    private func save() {
        error = nil
        let p = draft
        saving = true
        Task {
            error = await state.updateMachine(machine.id, policy: p)
            if error == nil {
                // What the relay stored (it may normalise the policy).
                let stored = state.machine(machine.id)?.policy ?? p
                draft = stored
                base = stored
                serverChanged = false
            }
            saved = error == nil
            saving = false
        }
    }

    private func addTyped() {
        let f = folderInput
        guard f.hasPrefix("/"), !draft.folders.contains(f) else { return }
        draft.folders.append(f)
        newFolder = ""
    }

    private func pickFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.prompt = "Allow"
        panel.message = "Folders where tasks may run. For another machine, type its path in the field instead."
        if panel.runModal() == .OK {
            for u in panel.urls where !draft.folders.contains(u.path) { draft.folders.append(u.path) }
        }
    }
}

/// Audit, Tasks: the task log of my machines (GET /owner/task-log).
struct TaskLogView: View {
    @EnvironmentObject var state: AppState
    @State private var events: [TaskEvent] = []
    @State private var machine = ""
    @State private var taskFilter = ""
    @State private var error: String?
    @State private var done = false
    @State private var loading = false

    var body: some View {
        VStack(spacing: 0) {
            if let error {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).padding(8)
            }
            Table(events) {
                TableColumn("Time") { Text(Fmt.when($0.at)).monospacedDigit().help(Fmt.stamp($0.at)) }
                    .width(min: 70, ideal: 110)
                TableColumn("Event") { e in EventLabel(type: e.type) }
                    .width(min: 100, ideal: 150)
                TableColumn("Machine") { e in Text(verbatim: e.machine.map { state.machineName($0) } ?? "") }
                    .width(min: 70, ideal: 120)
                TableColumn("Task") { e in
                    Text(verbatim: e.task ?? "").font(.system(.body, design: .monospaced)).foregroundStyle(.secondary)
                }
                .width(min: 70, ideal: 110)
                TableColumn("Actor") { Text(verbatim: $0.actor) }.width(min: 70, ideal: 120)
                TableColumn("Detail") { e in
                    let d = e.data?["text"]?.string ?? e.data?["name"]?.string ?? e.data?["summary"]?.string ?? e.data?.compact ?? ""
                    Text(verbatim: d == "{}" ? "" : d).foregroundStyle(.secondary).help(d)
                }
            }
        }
        .navigationTitle("Audit")
        .navigationSubtitle("\(events.count) task events")
        .toolbar {
            ToolbarItemGroup {
                Picker("Machine", selection: $machine) {
                    Text("All machines").tag("")
                    Divider()
                    ForEach(state.machines) { Text(verbatim: $0.name).tag($0.id) }
                }
                .frame(width: 150)
                TextField("Task id", text: $taskFilter)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 120)
                    .onSubmit { Task { await load(reset: true) } }
                Button { Task { await load(reset: false) } } label: { Label("Load Older", systemImage: "clock.arrow.circlepath") }
                    .disabled(done || loading)
                Button { Task { await load(reset: true) } } label: { Label("Reload", systemImage: "arrow.clockwise") }
            }
        }
        .task(id: machine) { await load(reset: true) }
    }

    private func load(reset: Bool) async {
        loading = true
        defer { loading = false }
        do {
            let before = reset ? nil : events.last?.id
            let page = try await state.taskLog(machine: machine.nilIfEmpty, task: taskFilter.trimmingCharacters(in: .whitespaces).nilIfEmpty, before: before)
            events = reset ? page : events + page
            done = page.count < 100
            error = nil
        } catch {
            self.error = (error as? RelayError)?.reason ?? error.localizedDescription
        }
    }
}

struct EventLabel: View {
    let type: String
    var body: some View {
        Label(type.replacingOccurrences(of: "_", with: " "), systemImage: symbol)
    }

    private var symbol: String {
        if type == "approval_decided" { return "checkmark.seal" }
        if type.contains("approv") { return "hand.raised" }
        if type.contains("reject") || type == "failed" { return "xmark.circle" }
        if type.contains("cancel") || type == "killed" { return "stop.circle" }
        switch type {
        case "created": return "plus.circle"
        case "started", "running": return "play.circle"
        case "finished", "done": return "flag.checkered"
        case "tool", "tool_result": return "wrench.and.screwdriver"
        case "progress": return "sparkles"
        case "status": return "arrow.right.circle"
        case "followup": return "arrowshape.turn.up.right.circle"
        case "accepted": return "tray.and.arrow.down"
        case "expired": return "hourglass"
        case "log": return "text.alignleft"
        case "policy", "machine_updated": return "slider.horizontal.3"
        default: return "circle"
        }
    }
}
