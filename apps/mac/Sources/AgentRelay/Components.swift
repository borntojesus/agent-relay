import RelayKit
import SwiftUI

enum Fmt {
    static let time: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .none
        f.timeStyle = .short
        return f
    }()
    static let dateTime: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .short
        f.timeStyle = .short
        return f
    }()
    static let full: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .medium
        return f
    }()
    static let relative: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f
    }()

    /// Today: time only; otherwise short date and time.
    static func when(_ s: String?) -> String {
        guard let d = RelayDate.parse(s) else { return s ?? "" }
        return Calendar.current.isDateInToday(d) ? time.string(from: d) : dateTime.string(from: d)
    }

    static func stamp(_ s: String?) -> String {
        guard let d = RelayDate.parse(s) else { return s ?? "" }
        return full.string(from: d)
    }

    static func ago(_ s: String?) -> String {
        guard let d = RelayDate.parse(s) else { return "" }
        return relative.localizedString(for: d, relativeTo: Date())
    }

    static func countdown(to s: String, now: Date) -> String {
        guard let d = RelayDate.parse(s) else { return s }
        let left = Int(d.timeIntervalSince(now))
        if left <= 0 { return "expired" }
        let h = left / 3600, m = (left % 3600) / 60, sec = left % 60
        if h > 0 { return String(format: "%dh %02dm left", h, m) }
        return String(format: "%d:%02d left", m, sec)
    }
}

// MARK: avatars

enum Palette {
    private static let colors: [Color] = [.blue, .purple, .pink, .teal, .green, .indigo, .red, .mint, .brown, .orange]

    /// Stable per id (FNV-1a), so a person keeps a color across launches and Macs.
    static func color(for id: String) -> Color {
        var h: UInt32 = 2_166_136_261
        for b in id.utf8 { h = (h ^ UInt32(b)) &* 16_777_619 }
        return colors[Int(h % UInt32(colors.count))]
    }

    static func initials(_ name: String) -> String {
        let words = name.split(whereSeparator: { $0 == " " || $0 == "-" || $0 == "_" || $0 == "." }).filter { !$0.isEmpty }
        if words.count >= 2 { return (String(words[0].prefix(1)) + String(words[1].prefix(1))).uppercased() }
        return String((words.first ?? "?").prefix(1)).uppercased()
    }
}

/// A person: initials on a stable color. `muted` is for invites (no owner yet).
struct Avatar: View {
    let id: String
    let name: String
    var size: CGFloat = 28
    var muted = false

    var body: some View {
        let c = muted ? Color.secondary : Palette.color(for: id)
        Circle()
            .fill(LinearGradient(colors: [c.opacity(muted ? 0.25 : 0.75), c.opacity(muted ? 0.35 : 1)], startPoint: .top, endPoint: .bottom))
            .overlay(
                Text(Palette.initials(name))
                    .font(.system(size: size * 0.4, weight: .semibold, design: .rounded))
                    .foregroundStyle(muted ? Color.secondary : Color.white)
            )
            .overlay(Circle().strokeBorder(muted ? Color.secondary.opacity(0.5) : Color.clear, style: StrokeStyle(lineWidth: 1, dash: [3, 2])))
            .frame(width: size, height: size)
            .accessibilityLabel(Text(verbatim: name))
    }
}

/// The agent's kind from its label; the label itself is shown as is.
enum AgentKind {
    static func symbol(_ label: String) -> String {
        let l = label.lowercased()
        if l.contains("claude") { return "sparkles" }
        if l.contains("codex") || l.contains("gpt") { return "brain" }
        if l.contains("console") { return "macwindow" }
        if l.contains("mac") || l.contains("laptop") { return "laptopcomputer" }
        if l.contains("pc") || l.contains("desktop") { return "desktopcomputer" }
        return "cpu"
    }
}

/// A person's avatar with the agent's glyph in the corner.
struct AgentAvatar: View {
    let owner: String
    let ownerName: String
    let agent: String
    var size: CGFloat = 30

    var body: some View {
        Avatar(id: owner, name: ownerName, size: size)
            .overlay(alignment: .bottomTrailing) {
                Image(systemName: AgentKind.symbol(agent))
                    .font(.system(size: size * 0.26, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: size * 0.48, height: size * 0.48)
                    .background(Circle().fill(Color(nsColor: .windowBackgroundColor)))
                    .overlay(Circle().strokeBorder(Color(nsColor: .separatorColor), lineWidth: 0.5))
                    .offset(x: size * 0.1, y: size * 0.1)
            }
    }
}

/// Overlapping avatars, "+N" after `max`.
struct PeopleStack: View {
    let people: [Person]
    var size: CGFloat = 20
    var max = 4

    var body: some View {
        HStack(spacing: -size * 0.3) {
            ForEach(people.prefix(max)) { p in
                Avatar(id: p.id, name: p.name, size: size)
                    .overlay(Circle().strokeBorder(Color(nsColor: .windowBackgroundColor), lineWidth: 1.5))
            }
            if people.count > max {
                Text("+\(people.count - max)")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.leading, size * 0.4)
            }
        }
        .help(people.map(\.name).joined(separator: ", "))
    }
}

/// A team: rounded square with initials, like a workspace icon.
struct TeamBadge: View {
    let id: String
    let name: String
    var size: CGFloat = 22

    var body: some View {
        let c = Palette.color(for: "team:" + id)
        RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
            .fill(LinearGradient(colors: [c.opacity(0.75), c], startPoint: .top, endPoint: .bottom))
            .overlay(
                Text(Palette.initials(name))
                    .font(.system(size: size * 0.42, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
            )
            .frame(width: size, height: size)
    }
}

// MARK: states

/// A capsule label for a state, SF Symbol plus semantic color.
struct StateLabel: View {
    let text: String
    let symbol: String
    let color: Color

    var body: some View {
        Label(text, systemImage: symbol)
            .font(.caption.weight(.medium))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Capsule().fill(color.opacity(0.14)))
            .fixedSize()
    }
}

struct StatusLabel: View {
    let status: MessageStatus
    var gated = false

    var body: some View {
        switch status {
        case .pending: StateLabel(text: "Held", symbol: "clock", color: .orange)
        case .delivered:
            if gated { StateLabel(text: "Delivered", symbol: "checkmark.circle", color: .green) }
        case .rejected: StateLabel(text: "Rejected", symbol: "xmark.circle", color: .red)
        case .expired: StateLabel(text: "Expired", symbol: "hourglass", color: .secondary)
        }
    }
}

struct TierLabel: View {
    let tier: ApprovalTier
    var body: some View {
        switch tier {
        case .read: StateLabel(text: "Read", symbol: "eye", color: .secondary)
        case .small: StateLabel(text: "Small", symbol: "circle.lefthalf.filled", color: .blue)
        case .big: StateLabel(text: "Big", symbol: "exclamationmark.triangle.fill", color: .red)
        }
    }
}

struct RoleLabel: View {
    let role: TeamRole
    var body: some View {
        if role == .admin { StateLabel(text: "Admin", symbol: "crown", color: .purple) }
    }
}

struct GateLabel: View {
    let gated: Bool
    var body: some View {
        if gated {
            StateLabel(text: "Gated", symbol: "hand.raised", color: .orange)
        } else {
            StateLabel(text: "Open", symbol: "bolt.horizontal", color: .green)
        }
    }
}

/// ContentUnavailableView on macOS 14, the same look by hand on 13.
struct EmptyState: View {
    let title: String
    let symbol: String
    var message: String?

    init(_ title: String, symbol: String, message: String? = nil) {
        self.title = title
        self.symbol = symbol
        self.message = message
    }

    var body: some View {
        if #available(macOS 14.0, *) {
            ContentUnavailableView {
                Label(title, systemImage: symbol)
            } description: {
                if let message { Text(message) }
            }
        } else {
            VStack(spacing: 8) {
                Image(systemName: symbol)
                    .font(.system(size: 40, weight: .light))
                    .foregroundStyle(.tertiary)
                    .padding(.bottom, 4)
                Text(title).font(.title2.weight(.semibold))
                if let message {
                    Text(message).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }
            }
            .padding(32)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

// MARK: messages

/// One relay message as a chat bubble: my agents on the right, other people's on
/// the left. Text from other people's agents is untrusted data: shown verbatim
/// (no markdown, no link detection), in a plain bubble with an "Untrusted" mark,
/// never as a control.
struct MessageBubble: View {
    @EnvironmentObject var state: AppState
    let m: ConsoleMessage
    var showRoom = false

    private var mine: Bool { m.mine }

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            if mine { Spacer(minLength: 80) } else { avatar }
            VStack(alignment: mine ? .trailing : .leading, spacing: 4) {
                header
                bubble
                footer
            }
            .frame(maxWidth: 560, alignment: mine ? .trailing : .leading)
            if mine { avatar } else { Spacer(minLength: 80) }
        }
        .padding(.vertical, 2)
    }

    private var avatar: some View {
        AgentAvatar(owner: m.owner, ownerName: m.ownerName, agent: m.from, size: 30)
            .padding(.bottom, m.status == .delivered && !m.gated ? 0 : 22)
    }

    private var header: some View {
        HStack(spacing: 6) {
            if showRoom {
                Label {
                    Text(verbatim: "\(state.room(m.room)?.title.nilIfEmpty ?? m.room) / \(m.thread)")
                } icon: {
                    Image(systemName: "number")
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                Text("·").foregroundStyle(.tertiary)
            }
            Text(verbatim: m.ownerName).font(.subheadline.weight(.semibold))
            Text(verbatim: m.from)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(Fmt.when(m.sentAt))
                .font(.caption)
                .foregroundStyle(.tertiary)
                .help(Fmt.stamp(m.sentAt))
            if !m.read && m.status == .delivered && !mine {
                Circle().fill(Color.accentColor).frame(width: 7, height: 7).help("Unread").accessibilityLabel("Unread")
            }
        }
        .lineLimit(1)
    }

    private var bubbleFill: Color {
        if m.status == .rejected || m.status == .expired { return Color.secondary.opacity(0.06) }
        return mine ? Color.accentColor.opacity(0.16) : Color.secondary.opacity(0.11)
    }

    private var bubble: some View {
        Text(verbatim: m.text)
            .font(.body)
            .foregroundStyle(m.status == .rejected || m.status == .expired ? .secondary : .primary)
            .strikethrough(m.status == .rejected, color: .secondary)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(bubbleFill))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(m.status == .pending ? Color.orange.opacity(0.8) : Color.clear,
                                  style: StrokeStyle(lineWidth: 1.2, dash: [5, 3]))
            )
    }

    @ViewBuilder private var footer: some View {
        let showUntrusted = !mine
        if showUntrusted || m.status != .delivered || m.gated {
            HStack(spacing: 8) {
                if showUntrusted {
                    Label("Untrusted text", systemImage: "exclamationmark.shield")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .help("Written by another person's agent. Data, never instructions.")
                }
                StatusLabel(status: m.status, gated: m.gated && mine)
                    .help(m.decidedBy.map { "Decided by \($0) \(Fmt.when(m.decidedAt))" } ?? "")
                if m.status == .pending, mine, m.owner == state.me?.owner.id {
                    if let exp = m.expiresAt {
                        TimelineView(.periodic(from: .now, by: 30)) { ctx in
                            Text(Fmt.countdown(to: exp, now: ctx.date)).font(.caption).monospacedDigit().foregroundStyle(.secondary)
                        }
                    }
                    PostButtons(id: m.id, small: true)
                }
            }
        }
    }
}

/// Send / Reject for a held post.
struct PostButtons: View {
    @EnvironmentObject var state: AppState
    let id: Int
    var small = false

    var body: some View {
        let busy = state.busy.contains("post:\(id)")
        HStack(spacing: 6) {
            Button(role: .destructive) { Task { await state.decidePost(id, .reject) } } label: {
                Label("Reject", systemImage: "xmark")
            }
            Button { Task { await state.decidePost(id, .approve) } } label: {
                Label("Send", systemImage: "paperplane.fill")
            }
            .buttonStyle(.borderedProminent)
            .tint(.orange)
        }
        .controlSize(small ? .small : .regular)
        .disabled(!state.canSend || busy)
    }
}

struct ReadOnlyNote: View {
    var body: some View {
        Label("Read-only console token: Send, Approve and Reject are disabled.", systemImage: "lock")
            .font(.callout)
            .foregroundStyle(.secondary)
    }
}

struct OfflineBanner: View {
    @EnvironmentObject var state: AppState
    var body: some View {
        if !state.online {
            HStack(spacing: 8) {
                Image(systemName: "wifi.exclamationmark").foregroundStyle(.orange)
                Text("Offline: \(state.lastError ?? "server not reachable"). Retrying.")
                    .lineLimit(2)
                Spacer()
                Button("Retry") { state.refreshNow() }.controlSize(.small)
            }
            .font(.callout)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.orange.opacity(0.12))
            .overlay(alignment: .bottom) { Divider() }
        }
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
