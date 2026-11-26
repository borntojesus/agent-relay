// API smoke against a running relay: exercises every console route the app uses.
//
//   RELAY_URL=http://127.0.0.1:8941 RELAY_OWNER=alice RELAY_TOKEN=... swift run relay-smoke [--decide]
//
// With --decide it also sends the first held post and approves the first approval.
import Foundation
import RelayKit

let env = ProcessInfo.processInfo.environment
guard let urlString = env["RELAY_URL"], let url = RelayClient.normalize(server: urlString),
      let owner = env["RELAY_OWNER"], let token = env["RELAY_TOKEN"] else {
    FileHandle.standardError.write("Set RELAY_URL, RELAY_OWNER and RELAY_TOKEN.\n".data(using: .utf8)!)
    exit(2)
}
let decide = CommandLine.arguments.contains("--decide")
let c = RelayClient(baseURL: url, owner: owner, token: token)
var failed = 0

func check(_ ok: Bool, _ msg: String) {
    print("\(ok ? "ok  " : "FAIL") \(msg)")
    if !ok { failed += 1 }
}

func step<T>(_ name: String, _ f: () async throws -> T) async -> T? {
    do { return try await f() } catch { check(false, "\(name): \(error.localizedDescription)"); return nil }
}

if let me = await step("me", { try await c.me() }) {
    check(me.owner.id == owner, "me: \(me.owner.id) token \(me.token.label) send=\(me.token.send) v\(me.version)")
}
// Wrong username must be refused.
do {
    _ = try await RelayClient(baseURL: url, owner: owner + "x", token: token).me()
    check(false, "wrong X-Relay-Owner accepted")
} catch let e as RelayError {
    check(e.status == 401, "wrong X-Relay-Owner -> \(e.status.map(String.init) ?? "?")")
}
if let s = await step("summary", { try await c.summary() }) {
    check(true, "summary: unread \(s.unread) own \(s.unreadOwn) posts \(s.pendingPosts) approvals \(s.pendingApprovals) feed \(s.feedCursor) audit \(s.auditCursor)")
}
if let r = await step("rooms", { try await c.rooms() }) {
    check(true, "rooms: " + r.rooms.map { "\($0.room)\($0.gated ? "[gated:\($0.owners.joined(separator: ","))]" : "") unread \($0.unread)" }.joined(separator: "; "))
    for room in r.rooms {
        if let t = await step("threads \(room.room)", { try await c.threads(room: room.room) }) {
            check(true, "threads \(room.room): \(t.threads.map(\.thread))")
            if let first = t.threads.first, let th = await step("thread", { try await c.thread(room: room.room, thread: first.thread) }) {
                check(th.trust == "untrusted", "thread \(room.room)/\(first.thread): \(th.messages.count) msgs, statuses \(Set(th.messages.map(\.status.rawValue)))")
                if await step("ack", { try await c.ack(room: room.room, thread: first.thread) }) != nil {
                    check(true, "ack \(room.room)/\(first.thread)")
                }
            }
        }
    }
}
if let f = await step("feed", { try await c.feed(after: 0) }) {
    check(f.trust == "untrusted", "feed: \(f.messages.count) msgs cursor \(f.cursor) more \(f.more)")
}
if let p = await step("pending", { try await c.pending() }) {
    check(true, "pending: posts \(p.posts.map { "\($0.id) seenBy \($0.seenBy ?? []) exp \($0.expiresAt ?? "")" }) approvals \(p.approvals.map { "\($0.id) \($0.tier.rawValue) \($0.action) caller \($0.caller)" })")
    if decide, let post = p.posts.first, let r = await step("decide post", { try await c.decidePost(id: post.id, .approve) }) {
        check(r.outcome == .delivered, "post \(post.id) -> \(r.outcome.rawValue)")
    }
    if decide, let a = p.approvals.first, let r = await step("decide approval", { try await c.decideApproval(id: a.id, .approve) }) {
        check(r.status == .approved, "approval \(a.id) -> \(r.status.rawValue)")
    }
}
if let a = await step("approvals", { try await c.approvals(limit: 20) }) {
    check(true, "approvals journal: \(a.approvals.count)")
}
if let a = await step("audit", { try await c.audit(limit: 5) }) {
    check(true, "audit: \(a.entries.map { "\($0.id) \($0.actor) \($0.action)" })")
    if let minId = a.entries.map(\.id).min(), let more = await step("audit before", { try await c.audit(before: minId, limit: 5) }) {
        check(more.entries.allSatisfy { $0.id < minId }, "audit before=\(minId): \(more.entries.count) rows")
    }
}
if let t = await step("tokens", { try await c.tokens() }) {
    check(t.tokens.contains { $0.current }, "tokens: " + t.tokens.map { "\($0.label)(\($0.kind.rawValue)\($0.current ? ",current" : ""))" }.joined(separator: " "))
    if let cur = t.tokens.first(where: { $0.current }) {
        do {
            try await c.revoke(label: cur.label)
            check(false, "revoking the current token was allowed")
        } catch let e as RelayError {
            check(e.status != nil, "revoke current refused: \(e.status!)")
        }
    }
}
if CommandLine.arguments.contains("--keychain") {
    // Round trip with a throwaway account, never the real token.
    let acct = Keychain.account(owner: "smoke-test", server: url)
    Keychain.delete(account: acct)
    check(Keychain.save(token: "dummy-1", account: acct), "keychain save \(acct)")
    check(Keychain.save(token: "dummy-2", account: acct), "keychain overwrite")
    check(Keychain.load(account: acct) == "dummy-2", "keychain load")
    Keychain.delete(account: acct)
    check(Keychain.load(account: acct) == nil, "keychain delete")
}
print(failed == 0 ? "ALL OK" : "\(failed) FAILED")
exit(failed == 0 ? 0 : 1)
