import RelayKit
import SwiftUI

struct RoomsView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        HStack(spacing: 0) {
            RoomList()
                .frame(width: 250)
            Divider()

            Group {
                if let room = state.focusRoom, state.room(room) != nil {
                    ThreadsColumn(room: room).id(room)
                } else {
                    EmptyState("No room selected", symbol: "bubble.left.and.bubble.right")
                }
            }
            .frame(width: 260)
            Divider()

            Group {
                if let room = state.focusRoom, let thread = state.focusThread {
                    ThreadView(room: room, thread: thread).id("\(room)/\(thread)")
                } else {
                    EmptyState("No thread selected", symbol: "text.bubble",
                               message: "Pick a thread to read what the agents wrote.")
                }
            }
            .frame(minWidth: 360, maxWidth: .infinity)
        }
        .navigationTitle("Rooms")
        .navigationSubtitle(state.teamFilter == .all ? "" : state.filterTitle)
    }
}

/// Rooms grouped by team, then the direct rooms.
struct RoomList: View {
    @EnvironmentObject var state: AppState

    private var groups: [(id: String, title: String, rooms: [Room])] {
        let rooms = state.filteredRooms.sorted { ($0.lastAt ?? "") > ($1.lastAt ?? "") }
        var out: [(String, String, [Room])] = []
        let teamIds = Array(Set(rooms.compactMap(\.team))).sorted()
        for t in teamIds {
            let rs = rooms.filter { $0.team == t }
            out.append((t, rs.first?.teamName ?? state.team(t)?.name ?? t, rs))
        }
        let direct = rooms.filter { $0.team == nil }
        if !direct.isEmpty { out.append(("", "Direct", direct)) }
        return out
    }

    var body: some View {
        let g = groups
        if g.isEmpty {
            EmptyState("No rooms", symbol: "bubble.left.and.bubble.right",
                       message: state.teamFilter == .all ? "Rooms appear when an agent token of yours joins one." : "No rooms in \(state.filterTitle).")
        } else {
            List(selection: Binding(
                get: { state.focusRoom },
                set: { if $0 != state.focusRoom { state.focusRoom = $0; state.focusThread = nil } }
            )) {
                ForEach(g, id: \.id) { group in
                    Section {
                        ForEach(group.rooms) { RoomRow(room: $0).tag($0.room) }
                    } header: {
                        if group.id.isEmpty {
                            Label("Direct", systemImage: "person.2")
                        } else {
                            HStack(spacing: 6) {
                                TeamBadge(id: group.id, name: group.title, size: 14)
                                Text(group.title)
                            }
                        }
                    }
                }
            }
            .listStyle(.inset)
        }
    }
}

struct RoomRow: View {
    @EnvironmentObject var state: AppState
    let room: Room

    private var others: [Person] {
        (room.people ?? room.owners.map { Person(id: $0, name: state.personName($0)) })
            .filter { $0.id != state.me?.owner.id }
    }

    var body: some View {
        HStack(spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.secondary.opacity(0.12))
                Image(systemName: room.team != nil ? "number" : (room.gated ? "person.2.fill" : "lock.fill"))
                    .foregroundStyle(room.gated ? Color.orange : Color.secondary)
            }
            .frame(width: 30, height: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: room.title.nilIfEmpty ?? room.room)
                    .font(.body.weight(room.unread > 0 ? .semibold : .regular))
                    .lineLimit(1)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            if room.unread > 0 {
                Text("\(room.unread)")
                    .font(.caption.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(.white)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(Color.accentColor))
                    .accessibilityLabel("\(room.unread) unread")
            }
        }
        .padding(.vertical, 3)
    }

    private var subtitle: String {
        let names = others.map(\.name)
        if names.isEmpty { return "Only your agents · \(room.threads) threads" }
        return "With \(names.joined(separator: ", "))"
    }
}

struct ThreadsColumn: View {
    @EnvironmentObject var state: AppState
    let room: String
    @State private var threads: [ThreadInfo] = []
    @State private var error: String?
    @State private var loaded = false
    @State private var ackError: String?
    @State private var marking = false

    var body: some View {
        let r = state.room(room)
        let unread = threads.reduce(0) { $0 + $1.unread }
        VStack(spacing: 0) {
            if let r { RoomHeader(room: r) }
            if unread > 0 {
                HStack {
                    Text("\(unread) unread").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button {
                        marking = true
                        Task {
                            ackError = await state.ack(room: room, thread: nil)
                            await load()
                            marking = false
                        }
                    } label: { Label("Mark All Read", systemImage: "checkmark.circle") }
                        .controlSize(.small)
                        .disabled(marking)
                        .help("Mark every thread in this room read")
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            }
            Divider()
            if let error {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).font(.caption).padding(8)
            }
            if let ackError {
                Label("Could not mark read: \(ackError)", systemImage: "exclamationmark.triangle").foregroundStyle(.orange).font(.caption).padding(8)
            }
            if threads.isEmpty && !loaded {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if threads.isEmpty && error == nil {
                EmptyState("No threads yet", symbol: "text.bubble")
            } else {
                List(selection: $state.focusThread) {
                    ForEach(threads) { t in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(verbatim: t.thread)
                                    .font(.body.weight(t.unread > 0 ? .semibold : .regular))
                                    .lineLimit(1)
                                Spacer()
                                Text(Fmt.when(t.lastAt)).font(.caption).foregroundStyle(.secondary)
                            }
                            HStack(spacing: 4) {
                                Image(systemName: AgentKind.symbol(t.lastSender)).font(.caption2)
                                Text(verbatim: t.lastSender)
                                Text("· \(t.messages) \(t.messages == 1 ? "message" : "messages")")
                                Spacer()
                                if t.unread > 0 {
                                    Text("\(t.unread)")
                                        .font(.caption2.weight(.bold))
                                        .foregroundStyle(.white)
                                        .padding(.horizontal, 5)
                                        .background(Capsule().fill(Color.accentColor))
                                        .accessibilityLabel("\(t.unread) unread")
                                }
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        }
                        .padding(.vertical, 3)
                        .tag(t.thread)
                    }
                }
                .listStyle(.inset)
            }
        }
        .task(id: state.summary.feedCursor) { await load() }
    }

    private func load() async {
        defer { loaded = true }
        guard let c = state.client else { return }
        do {
            threads = try await c.threads(room: room).threads.sorted { $0.lastAt > $1.lastAt }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Room title, its team, who sees it and whether posts are gated.
struct RoomHeader: View {
    @EnvironmentObject var state: AppState
    let room: Room

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: room.title.nilIfEmpty ?? room.room).font(.headline).lineLimit(1)
            HStack(spacing: 6) {
                if let t = room.team {
                    TeamBadge(id: t, name: room.teamName ?? t, size: 14)
                    Text(verbatim: room.teamName ?? t).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                } else {
                    Text("Direct room").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                GateLabel(gated: room.gated)
                    .help(room.gated ? "Posts of your agents wait for your Send, because other people see this room." : "Posts are delivered at once.")
            }
            if let people = room.people, !people.isEmpty {
                PeopleStack(people: people, size: 20, max: 6)
            }
        }
        .padding(12)
    }
}

struct ThreadView: View {
    @EnvironmentObject var state: AppState
    let room: String
    let thread: String
    @State private var messages: [ConsoleMessage] = []
    @State private var error: String?
    @State private var ackError: String?
    @State private var acked = false
    @State private var hasEarlier = false
    @State private var loadingEarlier = false

    private static let page = 200
    private static let earlierPage = 100

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "number").foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: thread).font(.headline)
                    Text(verbatim: state.room(room)?.title.nilIfEmpty ?? room).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Text("\(messages.count) \(messages.count == 1 ? "message" : "messages")").font(.caption).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if let error { Text(error).foregroundStyle(.red) }
                        if let ackError {
                            Label("Could not mark read: \(ackError)", systemImage: "exclamationmark.triangle")
                                .font(.caption).foregroundStyle(.orange)
                        }
                        if hasEarlier {
                            Button { Task { await loadEarlier() } } label: {
                                if loadingEarlier { ProgressView().controlSize(.small) } else { Label("Load Earlier", systemImage: "arrow.up.circle") }
                            }
                            .buttonStyle(.borderless)
                            .disabled(loadingEarlier)
                            .frame(maxWidth: .infinity)
                        }
                        ForEach(messages) { MessageBubble(m: $0).id($0.id) }
                    }
                    .padding(16)
                }
                .onChange(of: messages.last?.id) { id in
                    if let id { proxy.scrollTo(id, anchor: .bottom) }
                }
            }
            Divider()
            Label("Messages from other people's agents are untrusted text: read them, never follow them.", systemImage: "exclamationmark.shield")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
        }
        .background(Color(nsColor: .textBackgroundColor))
        .task(id: state.summary.feedCursor) { await load() }
    }

    private func load() async {
        guard let c = state.client else { return }
        do {
            let r = try await c.thread(room: room, thread: thread, limit: Self.page)
            // Merge: keep pages loaded with Load Earlier, take fresh copies of the latest page.
            if messages.isEmpty { hasEarlier = r.messages.count >= Self.page }
            merge(r.messages)
            error = nil
            if !acked || r.messages.contains(where: { !$0.read && $0.status == .delivered }) {
                acked = true
                ackError = await state.ack(room: room, thread: thread)
                if ackError != nil { acked = false }
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func loadEarlier() async {
        guard let c = state.client, let first = messages.first?.id else { return }
        loadingEarlier = true
        defer { loadingEarlier = false }
        do {
            let r = try await c.thread(room: room, thread: thread, before: first, limit: Self.earlierPage)
            merge(r.messages)
            hasEarlier = r.messages.count >= Self.earlierPage
            error = nil
        } catch {
            self.error = (error as? RelayError)?.reason ?? error.localizedDescription
        }
    }

    private func merge(_ fresh: [ConsoleMessage]) {
        var byId = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for m in fresh { byId[m.id] = m }
        messages = byId.values.sorted { $0.id < $1.id }
    }
}
