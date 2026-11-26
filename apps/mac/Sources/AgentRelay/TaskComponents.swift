import RelayKit
import SwiftUI

extension TaskStatus {
    var title: String {
        switch self {
        case .queued: return "Queued"
        case .awaitingTap: return "Awaiting tap"
        case .accepted: return "Accepted"
        case .running: return "Running"
        case .waitingApproval: return "Waiting approval"
        case .done: return "Done"
        case .failed: return "Failed"
        case .cancelled: return "Cancelled"
        }
    }

    var symbol: String {
        switch self {
        case .queued: return "clock"
        case .awaitingTap: return "hand.tap"
        case .accepted: return "tray.and.arrow.down"
        case .running: return "play.circle"
        case .waitingApproval: return "hand.raised"
        case .done: return "checkmark.circle"
        case .failed: return "xmark.octagon"
        case .cancelled: return "slash.circle"
        }
    }

    /// Semantic system colors: readable on light and dark backgrounds.
    var color: Color {
        switch self {
        case .queued: return .indigo
        case .awaitingTap: return .orange
        case .accepted: return .teal
        case .running: return .blue
        case .waitingApproval: return .purple
        case .done: return .green
        case .failed: return .red
        case .cancelled: return .secondary
        }
    }
}

struct TaskStatusChip: View {
    let status: TaskStatus
    var cancelRequested = false

    var body: some View {
        if cancelRequested && !status.terminal {
            StateLabel(text: "Cancelling", symbol: "stop.circle", color: .red)
        } else {
            StateLabel(text: status.title, symbol: status.symbol, color: status.color)
        }
    }
}

struct PriorityChip: View {
    let priority: TaskPriority
    var body: some View {
        switch priority {
        case .high: StateLabel(text: "High", symbol: "arrow.up", color: .red)
        case .low: StateLabel(text: "Low", symbol: "arrow.down", color: .secondary)
        case .normal: EmptyView()
        }
    }
}

enum Category {
    static func color(_ c: String) -> Color {
        switch c {
        case "push": return .orange
        case "deploy": return .purple
        case "delete": return .red
        case "prod": return .pink
        default: return .secondary
        }
    }

    static func symbol(_ c: String) -> String {
        switch c {
        case "push": return "arrow.up.circle"
        case "deploy": return "shippingbox"
        case "delete": return "trash"
        case "prod": return "server.rack"
        default: return "tag"
        }
    }
}

struct CategoryBadge: View {
    let category: String
    var body: some View {
        StateLabel(text: category, symbol: Category.symbol(category), color: Category.color(category))
    }
}

/// Online (green) / offline (grey) / killed (red) dot.
struct MachineDot: View {
    let machine: Machine?
    var size: CGFloat = 8

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .overlay(Circle().strokeBorder(Color.primary.opacity(0.12), lineWidth: 0.5))
            .help(label)
            .accessibilityElement()
            .accessibilityLabel(label)
    }

    private var label: String {
        guard let m = machine else { return "Unknown machine" }
        return m.killed ? "Stopped (kill switch on)" : m.online ? "Online" : "Offline"
    }

    private var color: Color {
        guard let m = machine else { return .secondary }
        if m.killed { return .red }
        return m.online ? .green : Color.secondary.opacity(0.6)
    }
}

/// A machine as a rounded icon with the online dot in the corner.
struct MachineIcon: View {
    let machine: Machine?
    var size: CGFloat = 30

    var body: some View {
        let name = (machine?.name ?? "").lowercased()
        let symbol = name.contains("studio") || name.contains("mini") || name.contains("desktop") || name.contains("pc")
            ? "desktopcomputer" : "laptopcomputer"
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
                .fill(Color.secondary.opacity(0.12))
            Image(systemName: symbol)
                .font(.system(size: size * 0.45))
                .foregroundStyle(machine?.killed == true ? Color.red : Color.primary.opacity(0.75))
        }
        .frame(width: size, height: size)
        .overlay(alignment: .bottomTrailing) {
            MachineDot(machine: machine, size: size * 0.3)
                .overlay(Circle().stroke(Color(nsColor: .windowBackgroundColor), lineWidth: 1.5))
                .offset(x: 2, y: 2)
        }
    }
}

/// Wraps children onto lines (chips, tokens).
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, maxX: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0, x + s.width > width { x = 0; y += line + spacing; line = 0 }
            x += s.width + spacing
            maxX = max(maxX, x - spacing)
            line = max(line, s.height)
        }
        return CGSize(width: min(maxX, width), height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > bounds.minX, x + s.width > bounds.maxX { x = bounds.minX; y += line + spacing; line = 0 }
            v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing
            line = max(line, s.height)
        }
    }
}

/// Editable token list: chips with a remove button, plus a field that adds on Return.
struct TokenListEditor: View {
    @Binding var tokens: [String]
    var placeholder: String
    var color: Color = .accentColor
    var disabled = false
    @State private var draft = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if tokens.isEmpty {
                Text("None").font(.callout).foregroundStyle(.tertiary)
            } else {
                FlowLayout(spacing: 6) {
                    ForEach(Array(tokens.enumerated()), id: \.offset) { i, t in
                        HStack(spacing: 4) {
                            Text(verbatim: t).font(.system(.callout, design: .monospaced))
                            if !disabled {
                                Button { tokens.remove(at: i) } label: {
                                    Image(systemName: "xmark").font(.system(size: 8, weight: .bold))
                                }
                                .buttonStyle(.plain)
                                .foregroundStyle(.secondary)
                                .help("Remove \(t)")
                            }
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(color.opacity(0.12)))
                        .overlay(Capsule().strokeBorder(color.opacity(0.25)))
                    }
                }
            }
            if !disabled {
                HStack(spacing: 6) {
                    TextField("", text: $draft, prompt: Text(placeholder))
                        .labelsHidden()
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.callout, design: .monospaced))
                        .onSubmit(add)
                    Button("Add", action: add).disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func add() {
        let t = draft.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return }
        if !tokens.contains(t) { tokens.append(t) }
        draft = ""
    }
}

extension Fmt {
    static func duration(ms: Double) -> String {
        let s = Int(ms / 1000)
        if s < 60 { return "\(max(s, 0))s" }
        if s < 3600 { return "\(s / 60)m \(s % 60)s" }
        return "\(s / 3600)h \((s % 3600) / 60)m"
    }

    static func duration(from a: String?, to b: String?) -> String? {
        guard let x = RelayDate.parse(a), let y = RelayDate.parse(b) else { return nil }
        return duration(ms: y.timeIntervalSince(x) * 1000)
    }
}
