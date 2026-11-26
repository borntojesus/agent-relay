import RelayKit
import SwiftUI

/// Team overview: members, invites, team rooms and the gate policy. Admins edit here.
struct TeamView: View {
    @EnvironmentObject var state: AppState
    @State private var picked: String?

    private var current: Team? {
        if case let .team(id) = state.teamFilter { return state.team(id) }
        return state.team(picked) ?? state.teams.first
    }

    var body: some View {
        Group {
            if state.teamFilter == .direct {
                EmptyState("Direct rooms have no team", symbol: "person.2",
                           message: "Switch to a team in the sidebar to see its members and rooms.")
            } else if let t = current {
                TeamDetail(team: t).id(t.id)
            } else {
                EmptyState("No teams", symbol: "person.3",
                           message: "When someone adds you to a team, its members, rooms and gate policy show up here.")
            }
        }
        .navigationTitle("Team")
        .navigationSubtitle(current?.name ?? "")
        .toolbar {
            if state.teamFilter == .all && state.teams.count > 1 {
                ToolbarItem {
                    Picker("Team", selection: Binding(get: { current?.id ?? "" }, set: { picked = $0 })) {
                        ForEach(state.teams) { Text($0.name).tag($0.id) }
                    }
                    .frame(width: 180)
                    .help("You are in several teams")
                }
            }
        }
    }
}

private enum TeamSheet: Identifiable {
    case rename, member, invite
    var id: Int { hashValue }
}

struct TeamDetail: View {
    @EnvironmentObject var state: AppState
    let team: Team
    @State private var sheet: TeamSheet?
    @State private var removeMember: TeamMember?
    @State private var removeInvite: TeamInvite?
    @State private var confirmGateOff = false

    private var admin: Bool { team.role == .admin && state.canSend }
    private var busy: Bool { state.busy.contains("team:\(team.id)") }

    private func setGate(_ g: TeamGate) {
        Task { await state.teamChange("team:\(team.id)") { try await $0.updateTeam(id: team.id, gate: g) } }
    }

    var body: some View {
        Form {
            Section {
                HStack(spacing: 14) {
                    TeamBadge(id: team.id, name: team.name, size: 52)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(team.name).font(.title2.weight(.semibold))
                        HStack(spacing: 6) {
                            Text(verbatim: "@\(team.id)").foregroundStyle(.secondary)
                            RoleLabel(role: team.role)
                            GateLabel(gated: team.gate == .on)
                        }
                        .font(.caption)
                    }
                    Spacer()
                    if busy { ProgressView().controlSize(.small) }
                    if admin {
                        Button("Rename…") { sheet = .rename }
                    }
                }
                .padding(.vertical, 4)
            }

            Section {
                ForEach(team.members) { m in
                    HStack(spacing: 10) {
                        Avatar(id: m.id, name: m.name, size: 30)
                        VStack(alignment: .leading, spacing: 1) {
                            HStack(spacing: 4) {
                                Text(m.name)
                                if m.id == state.me?.owner.id { Text("(you)").foregroundStyle(.secondary) }
                            }
                            Text(verbatim: "@\(m.id)").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if m.role == .admin { RoleLabel(role: .admin) }
                        if admin && m.id != state.me?.owner.id {
                            Button { removeMember = m } label: { Image(systemName: "minus.circle.fill") }
                                .buttonStyle(.borderless)
                                .foregroundStyle(.red)
                                .help("Remove \(m.name) from the team")
                        }
                    }
                }
                ForEach(team.invites) { i in
                    HStack(spacing: 10) {
                        Avatar(id: "invite:\(i.id)", name: i.name, size: 30, muted: true)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(i.name).foregroundStyle(.secondary)
                            Text(i.note?.nilIfEmpty ?? "Has no account yet").font(.caption).foregroundStyle(.tertiary)
                        }
                        Spacer()
                        StateLabel(text: "Invited", symbol: "envelope", color: .secondary)
                        if admin {
                            Button { removeInvite = i } label: { Image(systemName: "minus.circle.fill") }
                                .buttonStyle(.borderless)
                                .foregroundStyle(.red)
                                .help("Cancel the invite for \(i.name)")
                        }
                    }
                }
            } header: {
                HStack {
                    Text("Members")
                    Text("\(team.members.count)\(team.invites.isEmpty ? "" : " · \(team.invites.count) invited")")
                        .foregroundStyle(.secondary)
                    Spacer()
                    if admin {
                        Button { sheet = .invite } label: { Label("Invite", systemImage: "envelope") }
                            .buttonStyle(.borderless)
                        Button { sheet = .member } label: { Label("Add Member", systemImage: "person.badge.plus") }
                            .buttonStyle(.borderless)
                    }
                }
            }

            Section("Rooms") {
                if team.rooms.isEmpty {
                    Text("No team rooms yet.").foregroundStyle(.secondary)
                }
                ForEach(team.rooms, id: \.self) { id in
                    let r = state.room(id)
                    Button {
                        state.focusRoom = id
                        state.focusThread = nil
                        state.selection = .rooms
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "number").foregroundStyle(.secondary).frame(width: 20)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(verbatim: r?.title.nilIfEmpty ?? id).foregroundStyle(.primary)
                                Text(r.map { "\($0.threads) threads · last \(Fmt.ago($0.lastAt))" } ?? "Your agents have no token here")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if let u = r?.unread, u > 0 {
                                Text("\(u)").font(.caption.weight(.bold)).foregroundStyle(.white)
                                    .padding(.horizontal, 6).background(Capsule().fill(Color.accentColor))
                                    .accessibilityLabel("\(u) unread")
                            }
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(r == nil)
                }
            }

            Section {
                if admin {
                    Toggle(isOn: Binding(
                        get: { team.gate == .on },
                        set: { on in
                            // Turning the gate off loosens a safety check: ask first. Turning it on is safe.
                            if on { setGate(.on) } else { confirmGateOff = true }
                        }
                    )) {
                        Text("Hold posts for the poster's Send")
                    }
                    .disabled(busy)
                } else {
                    LabeledContent("Hold posts for the poster's Send", value: team.gate == .on ? "On" : "Off")
                }
            } header: {
                Text("Gate policy")
            } footer: {
                Text(team.gate == .on
                     ? "In team rooms, a post from an agent waits until its own person taps Send, because teammates will see it."
                     : "Team rooms deliver posts at once. Rooms shared with people outside the team stay gated.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .sheet(item: $sheet) { s in
            switch s {
            case .rename: RenameTeamSheet(team: team)
            case .member: AddMemberSheet(team: team)
            case .invite: InviteSheet(team: team)
            }
        }
        .confirmationDialog("Turn off the gate for \(team.name)?", isPresented: $confirmGateOff, titleVisibility: .visible) {
            Button("Turn Off Gate", role: .destructive) { setGate(.off) }
            Button("Keep It On", role: .cancel) {}
        } message: {
            Text("Team rooms stop needing a tap: a post from any member's agent is delivered to the team at once, without its person pressing Send. Rooms shared with people outside the team stay gated.")
        }
        .confirmationDialog("Remove \(removeMember?.name ?? "") from \(team.name)?",
                            isPresented: Binding(get: { removeMember != nil }, set: { if !$0 { removeMember = nil } }),
                            titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                if let m = removeMember {
                    Task { await state.teamChange("team:\(team.id)") { try await $0.removeTeamMember(team: team.id, owner: m.id) } }
                }
            }
            Button("Cancel", role: .cancel) { removeMember = nil }
        } message: {
            Text("Their agents lose access to the team rooms. Messages already sent stay.")
        }
        .confirmationDialog("Cancel the invite for \(removeInvite?.name ?? "")?",
                            isPresented: Binding(get: { removeInvite != nil }, set: { if !$0 { removeInvite = nil } }),
                            titleVisibility: .visible) {
            Button("Cancel Invite", role: .destructive) {
                if let i = removeInvite {
                    Task { await state.teamChange("team:\(team.id)") { try await $0.removeTeamInvite(team: team.id, invite: i.id) } }
                }
            }
            Button("Keep", role: .cancel) { removeInvite = nil }
        }
    }
}

// MARK: admin sheets

private struct SheetFrame<Content: View>: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let action: String
    let canSave: Bool
    let save: () async -> Bool
    @ViewBuilder let content: Content
    @State private var working = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title).font(.headline).padding([.top, .horizontal], 20)
            Form { content }
                .formStyle(.grouped)
                .scrollDisabledIfAvailable()
            HStack {
                Spacer()
                if working { ProgressView().controlSize(.small) }
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(action) {
                    working = true
                    Task {
                        if await save() { dismiss() }
                        working = false
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!canSave || working)
            }
            .padding([.bottom, .horizontal], 20)
        }
        .frame(width: 420)
        .fixedSize(horizontal: false, vertical: true)
    }
}

struct RenameTeamSheet: View {
    @EnvironmentObject var state: AppState
    let team: Team
    @State private var name = ""

    var body: some View {
        SheetFrame(title: "Rename Team", action: "Rename",
                   canSave: !name.trimmingCharacters(in: .whitespaces).isEmpty && name != team.name) {
            let n = name.trimmingCharacters(in: .whitespaces)
            return await state.teamChange("team:\(team.id)") { try await $0.updateTeam(id: team.id, name: n) }
        } content: {
            TextField("Name", text: $name)
            LabeledContent("Team id", value: "@\(team.id)")
        }
        .onAppear { name = team.name }
    }
}

struct AddMemberSheet: View {
    @EnvironmentObject var state: AppState
    let team: Team
    @State private var owner = ""
    @State private var role: TeamRole = .member

    private var clean: String { owner.trimmingCharacters(in: .whitespaces).lowercased() }

    var body: some View {
        SheetFrame(title: "Add Member to \(team.name)", action: "Add",
                   canSave: !clean.isEmpty && !clean.contains("@") && !team.members.contains { $0.id == clean }) {
            await state.teamChange("team:\(team.id)") { try await $0.addTeamMember(team: team.id, owner: clean, role: role) }
        } content: {
            TextField("Username", text: $owner, prompt: Text("carol"))
            if owner.contains("@") {
                Text("Username, not email: the person's relay id.").font(.caption).foregroundStyle(.red)
            }
            Picker("Role", selection: $role) {
                Text("Member").tag(TeamRole.member)
                Text("Admin").tag(TeamRole.admin)
            }
            .pickerStyle(.segmented)
            Text("The person needs a relay account. No account yet? Send an invite instead.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct InviteSheet: View {
    @EnvironmentObject var state: AppState
    let team: Team
    @State private var name = ""
    @State private var note = ""

    var body: some View {
        SheetFrame(title: "Invite to \(team.name)", action: "Invite",
                   canSave: !name.trimmingCharacters(in: .whitespaces).isEmpty) {
            let n = name.trimmingCharacters(in: .whitespaces)
            let t = note.trimmingCharacters(in: .whitespaces)
            return await state.teamChange("team:\(team.id)") { try await $0.addTeamInvite(team: team.id, name: n, note: t.isEmpty ? nil : t) }
        } content: {
            TextField("Name", text: $name, prompt: Text("Dana Ruiz"))
            TextField("Note", text: $note, prompt: Text("Designer, starts Monday"))
            Text("The invite shows in the member list until an admin adds the person's account.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}
