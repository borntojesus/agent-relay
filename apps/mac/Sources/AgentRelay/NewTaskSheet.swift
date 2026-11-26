import RelayKit
import SwiftUI

/// New task: which machine, which folder (inside the machine's allowed folders), what to do.
struct NewTaskSheet: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var machineId: String?
    @State private var folder = ""
    @State private var prompt = ""
    @State private var priority: TaskPriority = .normal
    @State private var error: String?

    private var machine: Machine? { state.machine(machineId) }
    private var folders: [String] { machine?.policy.folders ?? [] }

    /// The folder must be one of the allowed prefixes or inside one.
    private var folderOK: Bool {
        let f = folder.trimmingCharacters(in: .whitespaces)
        guard !f.isEmpty else { return false }
        return folders.contains { p in
            let base = p.hasSuffix("/") ? String(p.dropLast()) : p
            return f == base || f.hasPrefix(base + "/")
        }
    }

    private var canCreate: Bool {
        machine != nil && machine?.killed != true && folderOK
            && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && state.canSend
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Image(systemName: "checklist").font(.system(size: 22)).foregroundStyle(Color.accentColor)
                VStack(alignment: .leading, spacing: 1) {
                    Text("New Task").font(.title2.weight(.semibold))
                    Text("Claude Code runs it on the machine you pick, in one of its allowed folders.")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }

            field("Machine") {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 170), spacing: 8)], spacing: 8) {
                    ForEach(state.machines) { m in machineCard(m) }
                }
            }

            field("Folder") {
                HStack(spacing: 6) {
                    TextField(folders.first.map { "\($0)/project" } ?? "/path/to/project", text: $folder)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.body, design: .monospaced))
                    Menu {
                        if folders.isEmpty { Text("No allowed folders") }
                        ForEach(folders, id: \.self) { f in Button(f) { folder = f } }
                    } label: { Image(systemName: "folder") }
                    .menuStyle(.borderlessButton)
                    .frame(width: 44)
                    .help("Allowed folders of this machine")
                    .disabled(machine == nil)
                }
                Group {
                    if machine != nil, folders.isEmpty {
                        Label("This machine allows no folders yet. Add one in Machines, Policy.", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                    } else if !folder.isEmpty, !folderOK {
                        Label("Not inside an allowed folder of \(machine?.name ?? "this machine").", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                    } else if !folders.isEmpty {
                        Text("Allowed: \(folders.joined(separator: ", "))").foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    }
                }
                .font(.caption)
            }

            field("Prompt") {
                ZStack(alignment: .topLeading) {
                    TextEditor(text: $prompt)
                        .font(.body)
                        .scrollContentBackground(.hidden)
                        .padding(6)
                    if prompt.isEmpty {
                        Text("What should Claude do? For example: run the tests and fix what fails.")
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 11)
                            .padding(.vertical, 6)
                            .allowsHitTesting(false)
                    }
                }
                .frame(height: 140)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color(nsColor: .textBackgroundColor)))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color(nsColor: .separatorColor)))
            }

            field("Priority") {
                Picker("Priority", selection: $priority) {
                    ForEach(TaskPriority.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 240)
            }

            if let m = machine, m.policy.requireTap {
                Label("The policy of \(m.name) asks for a tap: the task waits in Approvals until you press Start.", systemImage: "hand.tap")
                    .font(.callout).foregroundStyle(.secondary)
            }
            if let error {
                Label(error, systemImage: "exclamationmark.octagon.fill").foregroundStyle(.red).font(.callout)
                    .textSelection(.enabled)
            }

            HStack {
                Spacer()
                if state.busy.contains("newtask") { ProgressView().controlSize(.small) }
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Create Task") { create() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canCreate || state.busy.contains("newtask"))
            }
        }
        .padding(22)
        .frame(width: 600)
        .onAppear {
            if machineId == nil {
                machineId = (state.machine(state.focusMachine) ?? state.machines.first { $0.online && !$0.killed } ?? state.machines.first)?.id
                if folder.isEmpty, let f = folders.first { folder = f }
            }
        }
        .onChange(of: machineId) { _ in
            if !folderOK { folder = folders.first ?? "" }
            error = nil
        }
    }

    private func field<C: View>(_ title: String, @ViewBuilder _ c: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
            c()
        }
    }

    private func machineCard(_ m: Machine) -> some View {
        let on = m.id == machineId
        return Button { machineId = m.id } label: {
            HStack(spacing: 8) {
                MachineIcon(machine: m, size: 28)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: m.name).font(.callout.weight(.semibold)).lineLimit(1)
                    Text(m.killed ? "Stopped" : m.online ? "Online" : "Offline \(Fmt.ago(m.lastSeen))")
                        .font(.caption).foregroundStyle(m.killed ? Color.red : Color.secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
                if on { Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.accentColor) }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(on ? Color.accentColor.opacity(0.12) : Color(nsColor: .controlBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(on ? Color.accentColor : Color(nsColor: .separatorColor), lineWidth: on ? 1.5 : 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(m.killed ? "Kill switch is on: tasks are refused" : m.online ? "Worker connected" : "Queued until the worker connects")
    }

    private func create() {
        guard let m = machine else { return }
        error = nil
        Task {
            switch await state.createTask(machine: m.id, folder: folder.trimmingCharacters(in: .whitespaces),
                                          prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines), priority: priority) {
            case .success: dismiss()
            case let .failure(e): error = e.message
            }
        }
    }
}
