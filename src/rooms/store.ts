import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export type MessageStatus = 'pending' | 'delivered' | 'rejected' | 'expired';

export interface Message {
  id: number;
  room: string;
  thread: string;
  senderToken: number;
  /** The label of the token that posted it; never taken from the request. */
  sender: string;
  /** The owner of that token. */
  senderOwner: string;
  sentAt: string;
  text: string;
  status: MessageStatus;
  /** 1 when the room had another owner's agents in it, so the sender's owner had to approve. */
  gated: boolean;
  nonce: string;
  cardId: number | null;
  decidedAt: string | null;
  decidedBy: string | null;
  /** Moves on every insert and status change: the console feed's cursor. */
  ver: number;
}

export interface Room {
  name: string;
  title: string;
  /** The team the room belongs to, null for a personal/direct room. */
  team: string | null;
  createdAt: string;
}

function toRoom(r: Record<string, unknown>): Room {
  return { name: String(r.name), title: String(r.title), team: (r.team as string | null) ?? null, createdAt: String(r.created_at) };
}

export interface ThreadSummary {
  thread: string;
  messages: number;
  /** Delivered messages from others that this token has not acknowledged. */
  unread: number;
  lastAt: string;
  lastSender: string;
}

const DELIVERED = "m.status = 'delivered'";
/** The next message version. */
const NEXT_VER = '(SELECT COALESCE(MAX(ver), 0) + 1 FROM messages)';
/** What an owner's console sees: delivered messages, plus its own agents' in any status. */
const VISIBLE_TO = "(m.status = 'delivered' OR m.sender_owner = ?)";
/** Not marked read by this token. */
const UNREAD_BY = 'NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.token_id = ?)';

function toMessage(r: Record<string, unknown>): Message {
  return {
    id: Number(r.id),
    room: String(r.room),
    thread: String(r.thread),
    senderToken: Number(r.sender_token),
    sender: String(r.sender_label),
    senderOwner: String(r.sender_owner),
    sentAt: String(r.sent_at),
    text: String(r.text),
    status: String(r.status) as MessageStatus,
    gated: r.gated === 1,
    nonce: String(r.nonce),
    cardId: (r.card_id as number | null) ?? null,
    decidedAt: (r.decided_at as string | null) ?? null,
    decidedBy: (r.decided_by as string | null) ?? null,
    ver: Number(r.ver ?? 0),
  };
}

/** A thread as an owner's console sees it. */
export interface OwnerThreadSummary {
  thread: string;
  messages: number;
  /** Delivered messages of other owners' agents this console token has not read. */
  unread: number;
  /** The same for the owner's own agents. */
  unreadOwn: number;
  lastAt: string;
  lastSender: string;
}

const inList = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/**
 * Rooms and their messages. A room has any number of member tokens (from any
 * number of owners); read state is kept per token in `message_reads`, so two
 * agents of the same owner each see a message as unread until each of them
 * acknowledges it.
 */
export class RoomStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  addRoom(name: string, title: string, atIso: string): Room {
    this.db
      .prepare('INSERT INTO rooms (name, title, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET title = excluded.title')
      .run(name, title, atIso);
    return this.room(name)!;
  }

  room(name: string): Room | undefined {
    const r = this.db.prepare('SELECT * FROM rooms WHERE name = ?').get(name) as Record<string, unknown> | undefined;
    return r ? toRoom(r) : undefined;
  }

  rooms(): Room[] {
    return (this.db.prepare('SELECT * FROM rooms ORDER BY name').all() as Array<Record<string, unknown>>).map(toRoom);
  }

  /** Moves a room into a team, or out of any (null). */
  setTeam(name: string, team: string | null): void {
    this.db.prepare('UPDATE rooms SET team = ? WHERE name = ?').run(team, name);
  }

  insert(m: Omit<Message, 'id' | 'cardId' | 'decidedAt' | 'decidedBy' | 'ver'>): Message {
    const res = this.db
      .prepare(
        `INSERT INTO messages (room, thread, sender_token, sender_label, sender_owner, sent_at, text, status, gated, nonce, ver)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NEXT_VER})`,
      )
      .run(m.room, m.thread, m.senderToken, m.sender, m.senderOwner, m.sentAt, m.text, m.status, m.gated ? 1 : 0, m.nonce);
    return this.get(Number(res.lastInsertRowid))!;
  }

  get(id: number): Message | undefined {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? toMessage(r) : undefined;
  }

  /**
   * The sender's owner decides a pending gated message, once. The update only
   * matches a row of that owner, with that nonce, still pending: another
   * owner's press, a stale card or a second tap changes nothing.
   */
  decide(owner: string, id: number, nonce: string, status: 'delivered' | 'rejected', by: string, atIso: string): Message | undefined {
    const res = this.db
      .prepare(
        `UPDATE messages SET status = ?, decided_at = ?, decided_by = ?, ver = ${NEXT_VER}
          WHERE id = ? AND sender_owner = ? AND nonce = ? AND gated = 1 AND status = 'pending'`,
      )
      .run(status, atIso, by, id, owner, nonce);
    return Number(res.changes) === 1 ? this.get(id) : undefined;
  }

  /** Rejects a pending message whose card could not be shown. */
  reject(id: number, by: string, atIso: string): void {
    this.db
      .prepare(`UPDATE messages SET status = 'rejected', decided_at = ?, decided_by = ?, ver = ${NEXT_VER} WHERE id = ? AND status = 'pending'`)
      .run(atIso, by, id);
  }

  /** Pending messages posted before a moment become expired; returns them. */
  expirePending(beforeIso: string, atIso: string): Message[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE status = 'pending' AND sent_at < ?")
      .all(beforeIso) as Array<Record<string, unknown>>;
    const out: Message[] = [];
    for (const r of rows) {
      const res = this.db
        .prepare(`UPDATE messages SET status = 'expired', decided_at = ?, decided_by = 'relay', ver = ${NEXT_VER} WHERE id = ? AND status = 'pending'`)
        .run(atIso, Number(r.id));
      if (Number(res.changes) === 1) out.push(toMessage(r));
    }
    return out;
  }

  /** Messages of one owner's agents waiting for that owner's tap, oldest first. */
  pendingFor(owner: string): Message[] {
    return (
      this.db
        .prepare("SELECT * FROM messages WHERE sender_owner = ? AND status = 'pending' ORDER BY id")
        .all(owner) as Array<Record<string, unknown>>
    ).map(toMessage);
  }

  pendingBySender(tokenId: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE sender_token = ? AND status = 'pending'").get(tokenId) as { n: number }).n;
  }

  setCard(id: number, cardId: number): void {
    this.db.prepare('UPDATE messages SET card_id = ? WHERE id = ?').run(cardId, id);
  }

  countBySenderSince(tokenId: number, sinceIso: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE sender_token = ? AND sent_at >= ?').get(tokenId, sinceIso) as { n: number }
    ).n;
  }

  threadCount(room: string): number {
    return (
      this.db.prepare(`SELECT COUNT(DISTINCT thread) AS n FROM messages m WHERE m.room = ? AND ${DELIVERED}`).get(room) as { n: number }
    ).n;
  }

  hasThread(room: string, thread: string): boolean {
    return this.db.prepare(`SELECT 1 FROM messages m WHERE m.room = ? AND m.thread = ? AND ${DELIVERED} LIMIT 1`).get(room, thread) !== undefined;
  }

  /** Delivered messages from other tokens that `tokenId` has not acknowledged, oldest first. */
  unread(rooms: readonly string[], tokenId: number, opts: { thread?: string; limit: number }): Message[] {
    if (!rooms.length) return [];
    const where = [`m.room IN (${rooms.map(() => '?').join(', ')})`, DELIVERED, 'm.sender_token <> ?', UNREAD_BY];
    const args: SQLInputValue[] = [...rooms, tokenId, tokenId];
    if (opts.thread) {
      where.push('m.thread = ?');
      args.push(opts.thread);
    }
    args.push(opts.limit);
    return (
      this.db.prepare(`SELECT m.* FROM messages m WHERE ${where.join(' AND ')} ORDER BY m.id LIMIT ?`).all(...args) as Array<Record<string, unknown>>
    ).map(toMessage);
  }

  unreadCount(rooms: readonly string[], tokenId: number): number {
    if (!rooms.length) return 0;
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM messages m WHERE m.room IN (${rooms.map(() => '?').join(', ')}) AND ${DELIVERED} AND m.sender_token <> ? AND ${UNREAD_BY}`,
        )
        .get(...rooms, tokenId, tokenId) as { n: number }
    ).n;
  }

  /**
   * Marks messages read for one token only: the ids given, a thread (up to an
   * id), or the whole room. A token never acknowledges its own messages.
   */
  ack(room: string, tokenId: number, atIso: string, what: { ids?: number[]; thread?: string; upTo?: number }): number {
    const where = ['m.room = ?', DELIVERED, 'm.sender_token <> ?', UNREAD_BY];
    const args: SQLInputValue[] = [tokenId, atIso, room, tokenId, tokenId];
    if (what.ids?.length) {
      where.push(`m.id IN (${what.ids.map(() => '?').join(', ')})`);
      args.push(...what.ids);
    }
    if (what.thread) {
      where.push('m.thread = ?');
      args.push(what.thread);
    }
    if (what.upTo !== undefined) {
      where.push('m.id <= ?');
      args.push(what.upTo);
    }
    const res = this.db
      .prepare(`INSERT OR IGNORE INTO message_reads (message_id, token_id, read_at) SELECT m.id, ?, ? FROM messages m WHERE ${where.join(' AND ')}`)
      .run(...args);
    return Number(res.changes);
  }

  isRead(messageId: number, tokenId: number): boolean {
    return this.db.prepare('SELECT 1 FROM message_reads WHERE message_id = ? AND token_id = ?').get(messageId, tokenId) !== undefined;
  }

  /** Labels of the tokens that acknowledged a message. */
  readBy(messageId: number): string[] {
    return (
      this.db
        .prepare('SELECT t.label FROM message_reads r JOIN tokens t ON t.id = r.token_id WHERE r.message_id = ? ORDER BY r.read_at')
        .all(messageId) as Array<{ label: string }>
    ).map((r) => r.label);
  }

  threads(room: string, tokenId: number): ThreadSummary[] {
    const rows = this.db
      .prepare(
        `SELECT m.thread AS thread, COUNT(*) AS messages,
                SUM(CASE WHEN m.sender_token <> ? AND ${UNREAD_BY} THEN 1 ELSE 0 END) AS unread,
                MAX(m.id) AS last_id
           FROM messages m WHERE m.room = ? AND ${DELIVERED} GROUP BY m.thread ORDER BY last_id DESC`,
      )
      .all(tokenId, tokenId, room) as Array<{ thread: string; messages: number; unread: number; last_id: number }>;
    const last = this.db.prepare('SELECT sender_label, sent_at FROM messages WHERE id = ?');
    return rows.map((r) => {
      const l = last.get(r.last_id) as { sender_label: string; sent_at: string };
      return { thread: r.thread, messages: r.messages, unread: r.unread, lastAt: l.sent_at, lastSender: l.sender_label };
    });
  }

  /** A thread's delivered messages, oldest first: the last `limit` before `before`. */
  history(room: string, thread: string, opts: { limit: number; before?: number }): Message[] {
    const rows = (
      opts.before !== undefined
        ? this.db
            .prepare(`SELECT m.* FROM messages m WHERE m.room = ? AND m.thread = ? AND ${DELIVERED} AND m.id < ? ORDER BY m.id DESC LIMIT ?`)
            .all(room, thread, opts.before, opts.limit)
        : this.db
            .prepare(`SELECT m.* FROM messages m WHERE m.room = ? AND m.thread = ? AND ${DELIVERED} ORDER BY m.id DESC LIMIT ?`)
            .all(room, thread, opts.limit)
    ) as Array<Record<string, unknown>>;
    return rows.reverse().map(toMessage);
  }

  // Owner console: every query below takes the owner and keeps to what that
  // owner may see (VISIBLE_TO), so a caller cannot widen it.

  /** Visible messages in the rooms with `ver` above `after`, oldest version first. */
  feed(rooms: readonly string[], owner: string, after: number, limit: number): Message[] {
    if (!rooms.length) return [];
    return (
      this.db
        .prepare(`SELECT m.* FROM messages m WHERE m.room IN (${inList(rooms.length)}) AND ${VISIBLE_TO} AND m.ver > ? ORDER BY m.ver LIMIT ?`)
        .all(...rooms, owner, after, limit) as Array<Record<string, unknown>>
    ).map(toMessage);
  }

  /** The highest `ver` of the visible messages in the rooms, 0 when none. */
  maxVer(rooms: readonly string[], owner: string): number {
    if (!rooms.length) return 0;
    const r = this.db
      .prepare(`SELECT COALESCE(MAX(m.ver), 0) AS v FROM messages m WHERE m.room IN (${inList(rooms.length)}) AND ${VISIBLE_TO}`)
      .get(...rooms, owner) as { v: number };
    return r.v;
  }

  /**
   * Delivered messages a console token has not read: from other owners'
   * agents, or (`own`) from the owner's own agents.
   */
  ownerUnread(rooms: readonly string[], owner: string, tokenId: number, own: boolean): number {
    if (!rooms.length) return 0;
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM messages m WHERE m.room IN (${inList(rooms.length)}) AND ${DELIVERED}
             AND m.sender_owner ${own ? '=' : '<>'} ? AND ${UNREAD_BY}`,
        )
        .get(...rooms, owner, tokenId) as { n: number }
    ).n;
  }

  /** Last visible message time and visible thread count of a room. */
  ownerRoomStats(room: string, owner: string): { lastAt: string | null; threads: number } {
    const r = this.db
      .prepare(`SELECT MAX(m.sent_at) AS last_at, COUNT(DISTINCT m.thread) AS threads FROM messages m WHERE m.room = ? AND ${VISIBLE_TO}`)
      .get(room, owner) as { last_at: string | null; threads: number };
    return { lastAt: r.last_at ?? null, threads: r.threads };
  }

  ownerThreads(room: string, owner: string, tokenId: number): OwnerThreadSummary[] {
    const rows = this.db
      .prepare(
        `SELECT m.thread AS thread, COUNT(*) AS messages,
                SUM(CASE WHEN ${DELIVERED} AND m.sender_owner <> ? AND ${UNREAD_BY} THEN 1 ELSE 0 END) AS unread,
                SUM(CASE WHEN ${DELIVERED} AND m.sender_owner = ? AND ${UNREAD_BY} THEN 1 ELSE 0 END) AS unread_own,
                MAX(m.id) AS last_id
           FROM messages m WHERE m.room = ? AND ${VISIBLE_TO} GROUP BY m.thread ORDER BY last_id DESC`,
      )
      .all(owner, tokenId, owner, tokenId, room, owner) as Array<{ thread: string; messages: number; unread: number; unread_own: number; last_id: number }>;
    const last = this.db.prepare('SELECT sender_label, sent_at FROM messages WHERE id = ?');
    return rows.map((r) => {
      const l = last.get(r.last_id) as { sender_label: string; sent_at: string };
      return { thread: r.thread, messages: r.messages, unread: r.unread, unreadOwn: r.unread_own, lastAt: l.sent_at, lastSender: l.sender_label };
    });
  }

  /** A thread's visible messages, oldest first: the last `limit` before `before`. */
  ownerHistory(room: string, thread: string, owner: string, opts: { limit: number; before?: number }): Message[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m WHERE m.room = ? AND m.thread = ? AND ${VISIBLE_TO} AND m.id < ? ORDER BY m.id DESC LIMIT ?`,
      )
      .all(room, thread, owner, opts.before ?? Number.MAX_SAFE_INTEGER, opts.limit) as Array<Record<string, unknown>>;
    return rows.reverse().map(toMessage);
  }
}
