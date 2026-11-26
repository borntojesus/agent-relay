import AppKit
import RelayKit
import SwiftUI

enum MachineTab: String, CaseIterable, Identifiable {
    case overview = "Overview"
    case policy = "Policy"
    var id: String { rawValue }
}

/// Tasks between own machines (0.5.0): polling, actions, notifications.
extension AppState {
    func resetTasks() {
        tasksSupported = false
        machines = []
        tasks = []
        pendingTasks = 0
        focusTask = nil
        focusMachine = nil
        knownTaskStatus = [:]
        knownToolApprovals = []
        Notifier.shared.remove(Array(waitingTaskNotes))
        waitingTaskNotes = []
        lastPendingTasks = nil
        tasksPrimed = false
        if selection == .tasks || selection == .machines { selection = .approvals }
    }

    /// Which of my machines this Mac is (Settings), sent as `sourceMachine`. Informational only.
    var thisMachine: String? { UserDefaults.standard.string(forKey: "thisMachine")?.nilIfEmpty }

    func machine(_ id: String?) -> Machine? { id.flatMap { id in machines.first { $0.id == id } } }
    func task(_ id: String?) -> RelayTask? { id.flatMap { id in tasks.first { $0.id == id } } }
    func machineName(_ id: String) -> String { machine(id)?.name ?? id }

    var tasksAwaitingTap: [RelayTask] { tasks.filter { $0.status == .awaitingTap } }

    /// Pending tool approvals with their task, oldest first.
    var pendingToolApprovals: [(task: RelayTask, approval: ToolApproval)] {
        tasks.flatMap { t in t.pendingApprovals.filter { $0.status == .pending }.map { (t, $0) } }
            .sorted { ($0.approval.createdAt ?? "") < ($1.approval.createdAt ?? "") }
    }

    /// Called from every poll tick with the fresh summary. Cheap: machines every 6th tick;
    /// the task list only when `summary.pendingTasks` changed, every 6th tick (30 s), or
    /// every 2nd tick while a task runs; the waiting lists when the count says some are missing.
    func loadTasksData(_ c: RelayClient, summary s: Summary, first: Bool, tick: Int) async {
        if first || tick % 6 == 0 || !tasksSupported {
            if !first, !tasksSupported, tick % 12 != 0 { return } // older relay: re-probe once a minute
            do {
                machines = try await c.machines().machines.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
                tasksSupported = true
            } catch let e as RelayError where e.status == 404 {
                resetTasks()
                return
            } catch {
                if !tasksSupported { return }
            }
        }
        guard tasksSupported else { return }
        let changed = s.pendingTasks != lastPendingTasks
        lastPendingTasks = s.pendingTasks
        let active = tasks.contains { !$0.status.terminal }
        if first || changed || tick % 6 == 0 || (active && tick % 2 == 0) {
            await loadTasks(c)
        }
        if let p = s.pendingTasks { pendingTasks = p }
        let known = tasksAwaitingTap.count + pendingToolApprovals.count
        if known < pendingTasks || first || tick % 6 == 0 {
            await loadWaiting(c)
        }
        if s.pendingTasks == nil { pendingTasks = tasksAwaitingTap.count + pendingToolApprovals.count }
        notifyTaskChanges()
        updateDockBadge()
    }

    func loadTasks(_ c: RelayClient? = nil) async {
        guard let c = c ?? client else { return }
        guard let recent = try? await c.tasks(limit: 200).tasks else { return }
        merge(recent, replaceAll: true)
    }

    private func loadWaiting(_ c: RelayClient) async {
        var extra: [RelayTask] = []
        for s in [TaskStatus.awaitingTap, .waitingApproval] {
            if let ts = try? await c.tasks(status: s, limit: 200).tasks { extra += ts }
        }
        merge(extra, replaceAll: false)
    }

    /// `replaceAll`: the recent list is authoritative for the tasks it has; older waiting
    /// tasks that fell off it are kept only while they still wait.
    private func merge(_ fresh: [RelayTask], replaceAll: Bool) {
        var byId = Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        if replaceAll {
            let ids = Set(fresh.map(\.id))
            byId = byId.filter { ids.contains($0.key) || $0.value.status == .awaitingTap || $0.value.status == .waitingApproval }
        }
        for t in fresh { byId[t.id] = t }
        tasks = byId.values.sorted { ($0.createdAt ?? "") > ($1.createdAt ?? "") }
    }

    func apply(task t: RelayTask) { merge([t], replaceAll: false) }

    func apply(machine m: Machine) {
        if let i = machines.firstIndex(where: { $0.id == m.id }) { machines[i] = m } else { machines.append(m) }
    }

    private func notifyTaskChanges() {
        let myToken = me?.token.label
        if tasksPrimed {
            for t in tasks {
                let before = knownTaskStatus[t.id]
                if let before, !before.terminal, t.status.terminal {
                    Notifier.shared.taskFinished(t, enabled: notificationsEnabled)
                } else if before == nil, t.status == .awaitingTap, t.createdBy != myToken {
                    Notifier.shared.taskAwaitingTap(t, enabled: notificationsEnabled)
                }
            }
            for (t, a) in pendingToolApprovals where !knownToolApprovals.contains(a.id) {
                Notifier.shared.toolApproval(a, task: t, enabled: notificationsEnabled)
            }
        }
        // Taps and tool approvals no longer waiting (decided here, in Telegram or elsewhere).
        let waiting = Set(tasksAwaitingTap.map { "tap-\($0.id)" } + pendingToolApprovals.map { "tool-\($0.approval.id)" })
        Notifier.shared.remove(Array(waitingTaskNotes.subtracting(waiting)))
        waitingTaskNotes = waiting
        for t in tasks { knownTaskStatus[t.id] = t.status }
        knownToolApprovals.formUnion(pendingToolApprovals.map(\.approval.id))
        tasksPrimed = true
    }

    // MARK: actions

    /// Runs a task action; on success reloads the tasks. Errors go to the alert unless `inline`.
    @discardableResult
    func taskAction(_ key: String, inline: Bool = false, _ f: (RelayClient) async throws -> Void) async -> String? {
        if fixtureMode { return nil }
        guard let c = client, canSend else { return "Read-only console token." }
        busy.insert(key)
        defer { busy.remove(key) }
        do {
            try await f(c)
        } catch let e as RelayError {
            if !inline { actionError = e.localizedDescription }
            await loadTasks(c)
            return e.reason
        } catch {
            if !inline { actionError = error.localizedDescription }
            return error.localizedDescription
        }
        await loadTasks(c)
        if let p = try? await c.summary().pendingTasks { pendingTasks = p } else {
            pendingTasks = tasksAwaitingTap.count + pendingToolApprovals.count
        }
        updateDockBadge()
        return nil
    }

    func startTask(_ id: String) async {
        Notifier.shared.remove(["tap-\(id)"])
        await taskAction("task:\(id)") { self.apply(task: try await $0.startTask(id: id)) }
    }

    func cancelTask(_ id: String) async {
        Notifier.shared.remove(["tap-\(id)"])
        await taskAction("task:\(id)") { self.apply(task: try await $0.cancelTask(id: id)) }
    }

    func decideTool(task: String, approval: String, _ d: Decision) async {
        Notifier.shared.remove(["tool-\(approval)"])
        await taskAction("tool:\(approval)") { self.apply(task: try await $0.decideToolApproval(task: task, approval: approval, d)) }
    }

    /// GET /owner/tasks/:id for the open detail; keeps it current even when it is off the recent list.
    func refreshTask(_ id: String) async {
        if fixtureMode { return }
        guard let c = client, let t = try? await c.task(id: id) else { return }
        apply(task: t)
    }

    /// Creates a task; returns the new task or a server reason (400) for inline display.
    func createTask(machine: String, folder: String, prompt: String, priority: TaskPriority) async -> Result<RelayTask, TaskError> {
        if fixtureMode { return .failure(TaskError("Snapshot mode: nothing is sent.")) }
        guard let c = client, canSend else { return .failure(TaskError("Read-only console token.")) }
        busy.insert("newtask")
        defer { busy.remove("newtask") }
        do {
            let t = try await c.createTask(machine: machine, folder: folder, prompt: prompt, priority: priority, sourceMachine: thisMachine)
            apply(task: t)
            knownTaskStatus[t.id] = t.status
            focusTask = t.id
            await loadTasks(c)
            return .success(t)
        } catch let e as RelayError {
            return .failure(TaskError(e.reason))
        } catch {
            return .failure(TaskError(error.localizedDescription))
        }
    }

    func followUp(_ id: String, prompt: String) async -> Result<RelayTask, TaskError> {
        if fixtureMode { return .failure(TaskError("Snapshot mode: nothing is sent.")) }
        guard let c = client, canSend else { return .failure(TaskError("Read-only console token.")) }
        busy.insert("followup:\(id)")
        defer { busy.remove("followup:\(id)") }
        do {
            let t = try await c.followUp(task: id, prompt: prompt)
            apply(task: t)
            knownTaskStatus[t.id] = t.status
            focusTask = t.id
            return .success(t)
        } catch let e as RelayError {
            return .failure(TaskError(e.reason))
        } catch {
            return .failure(TaskError(error.localizedDescription))
        }
    }

    /// PATCH a machine; returns the server's reason on failure (shown inline).
    func updateMachine(_ id: String, name: String? = nil, policy: MachinePolicy? = nil, killed: Bool? = nil) async -> String? {
        if fixtureMode { return nil }
        guard let c = client, canSend else { return "Read-only console token." }
        busy.insert("machine:\(id)")
        defer { busy.remove("machine:\(id)") }
        do {
            apply(machine: try await c.updateMachine(id: id, name: name, policy: policy, killed: killed))
            if killed != nil { await loadTasks(c) }
            return nil
        } catch let e as RelayError {
            return e.reason
        } catch {
            return error.localizedDescription
        }
    }

    func reloadMachines() async {
        if fixtureMode { return }
        guard let c = client else { return }
        if let ms = try? await c.machines().machines {
            machines = ms.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        }
    }

    /// Events of a task after `after` (fixtures in snapshot mode).
    func taskEvents(_ id: String, after: Int?) async throws -> [TaskEvent] {
        if fixtureMode { return after == nil ? Fixtures.events(for: id) : [] }
        guard let c = client else { return [] }
        return try await c.taskEvents(id: id, after: after).events
    }

    func taskLog(machine: String?, task: String?, before: Int?) async throws -> [TaskEvent] {
        if fixtureMode { return before == nil ? Fixtures.taskLog() : [] }
        guard let c = client else { return [] }
        return try await c.taskLog(machine: machine, task: task, limit: 100, before: before).events
    }
}

struct TaskError: Error {
    let message: String
    init(_ m: String) { message = m }
}
