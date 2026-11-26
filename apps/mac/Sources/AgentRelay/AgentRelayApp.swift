import AppKit
import RelayKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        if SnapshotMode.dir != nil {
            // Docs screenshots: sign in from the environment, render, quit.
            Task { @MainActor in SnapshotMode.run(AppState.shared) }
            return
        }
        Notifier.shared.setUp()
        Task { @MainActor in AppState.shared.restore() }
        // SwiftUI restores "window closed" from the last run; a Dock app should
        // always come up with its window.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            if !NSApp.windows.contains(where: { $0.isVisible && $0.title == "Agent Relay" }) {
                AppState.shared.showMain()
            }
        }
    }

    // A regular Dock app: closing the window keeps it running (polling, notifications,
    // Dock badge); clicking the Dock icon brings the window back, Cmd+Q quits.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { Task { @MainActor in AppState.shared.showMain() } }
        return true
    }
}

@main
struct AgentRelayApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var state = AppState.shared
    /// Optional menu bar item next to the Dock app. Off by default.
    @AppStorage("showMenuBarExtra") private var showMenuBarExtra = false

    var body: some Scene {
        Window("Agent Relay", id: "main") {
            RootView()
                .environmentObject(state)
                .frame(minWidth: 900, minHeight: 560)
        }
        .defaultSize(width: 1200, height: 750)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Task...") {
                    state.showMain(section: .tasks)
                    state.showNewTask = true
                }
                .keyboardShortcut("n")
                .disabled(!state.signedIn || !state.tasksSupported || !state.canSend || state.machines.isEmpty)
            }
            CommandMenu("Relay") {
                Button("Refresh") { state.refreshNow() }
                    .keyboardShortcut("r")
                    .disabled(!state.signedIn)
                Divider()
                ForEach(Array(SidebarItem.allCases.enumerated()), id: \.element) { i, item in
                    Button(item.title) { state.selection = item }
                        .keyboardShortcut(KeyEquivalent(Character(String(i + 1))), modifiers: .command)
                        .disabled(!state.signedIn || (item == .team && !state.teamsSupported)
                                   || ([.tasks, .machines].contains(item) && !state.tasksSupported))
                }
            }
        }

        Settings {
            SettingsView()
                .environmentObject(state)
        }

        MenuBarExtra(isInserted: $showMenuBarExtra) {
            MenuContent()
                .environmentObject(state)
        } label: {
            MenuLabel()
                .environmentObject(state)
        }
        .menuBarExtraStyle(.window)
    }
}

/// Status item: an icon plus "pending·unread" when either is non-zero.
struct MenuLabel: View {
    @EnvironmentObject var state: AppState
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        let p = state.pendingCount
        let u = state.summary.unread
        HStack(spacing: 3) {
            Image(systemName: !state.signedIn ? "bubble.left.and.bubble.right"
                : (!state.online ? "wifi.exclamationmark" : (p > 0 ? "bubble.left.and.bubble.right.fill" : "bubble.left.and.bubble.right")))
            if state.signedIn, p > 0 || u > 0 {
                Text(p > 0 && u > 0 ? "\(p)·\(u)" : (p > 0 ? "\(p)" : "\(u)"))
                    .monospacedDigit()
            }
        }
        .onAppear { state.openMainWindowAction = { openWindow(id: "main") } }
    }
}
