import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { checkMachineGrant, checkOwnerGrant, GrantError, isConsole, machinesOf, NAME, parseGrants, teamsOf, type Grant } from './grants.ts';

/** One person whose agents use the relay; they approve their own agents' outside messages. */
export interface Owner {
  id: string;
  name: string;
  /** Telegram user id of the owner; their bot only answers this user. */
  telegramUser: string | null;
  /** IANA time zone for times on cards. */
  tz: string;
  createdAt: string;
}

/** An authenticated agent. The sender of every message is taken from here, never from a request. */
export interface Caller {
  tokenId: number;
  /** `token:<id>`: the stable key for rate limits, read marks and approvals. */
  key: string;
  label: string;
  owner: string;
  grants: readonly Grant[];
}

export interface TokenInfo {
  id: number;
  label: string;
  owner: string;
  grants: Grant[];
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

/** `last_used_at` is written at most this often per token. */
const LAST_USED_EVERY_MS = 60_000;

/** Tokens are at least 32 random bytes; the database keeps only a sha256. */
export const TOKEN_PREFIX = 'ar_';
const LABEL = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export class TokenStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  addOwner(o: { id: string; name: string; telegramUser?: string | null; tz?: string }): Owner {
    const id = o.id.trim().toLowerCase();
    if (!NAME.test(id)) throw new Error('owner id: lowercase letters, digits and dashes, up to 32');
    if (!o.name.trim()) throw new Error('owner name is required');
    if (o.telegramUser && !/^\d{1,20}$/.test(o.telegramUser)) throw new Error('telegram user is a numeric id');
    const tz = o.tz ?? 'UTC';
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
    } catch {
      throw new Error(`unknown time zone ${tz}`);
    }
    this.db
      .prepare(
        `INSERT INTO owners (id, name, telegram_user, tz, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, telegram_user = excluded.telegram_user, tz = excluded.tz`,
      )
      .run(id, o.name.trim(), o.telegramUser ?? null, tz, this.iso());
    return this.owner(id)!;
  }

  owner(id: string): Owner | undefined {
    const r = this.db.prepare('SELECT * FROM owners WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? toOwner(r) : undefined;
  }

  owners(): Owner[] {
    return (this.db.prepare('SELECT * FROM owners ORDER BY id').all() as Array<Record<string, unknown>>).map(toOwner);
  }

  /** Makes a token and returns its secret once; only the hash is stored. */
  create(t: { label: string; owner: string; grants: unknown }): { token: string; info: TokenInfo } {
    const label = t.label.trim().toLowerCase();
    if (!LABEL.test(label)) throw new Error('label: lowercase letters, digits, dot, dash, underscore, up to 48');
    if (!this.owner(t.owner)) throw new Error(`no such owner: ${t.owner}`);
    const grants = parseGrants(t.grants);
    checkOwnerGrant(grants, t.owner);
    this.checkTeamGrants(grants, t.owner);
    this.checkMachineGrants(grants, t.owner);
    const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const res = this.db
      .prepare('INSERT INTO tokens (label, owner, hash, grants, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(label, t.owner, hashToken(token), JSON.stringify(grants), this.iso());
    return { token, info: this.info(Number(res.lastInsertRowid))! };
  }

  setGrants(label: string, grants: unknown): TokenInfo {
    const parsed = parseGrants(grants);
    const current = this.list().find((t) => t.label === label);
    if (!current) throw new Error(`no such active token: ${label}`);
    checkOwnerGrant(parsed, current.owner);
    this.checkTeamGrants(parsed, current.owner);
    this.checkMachineGrants(parsed, current.owner);
    const res = this.db
      .prepare('UPDATE tokens SET grants = ? WHERE label = ? AND revoked_at IS NULL')
      .run(JSON.stringify(parsed), label);
    if (Number(res.changes) !== 1) throw new Error(`no such active token: ${label}`);
    return this.list().find((t) => t.label === label)!;
  }

  /**
   * A `team:<id>` grant only for a team the owner is a member of. Membership
   * is checked again on every use, so a removed member's grant reaches nothing.
   */
  private checkTeamGrants(grants: readonly Grant[], owner: string): void {
    for (const team of teamsOf(grants)) {
      if (!this.db.prepare('SELECT 1 FROM teams WHERE id = ?').get(team)) throw new GrantError(`team:${team}: no such team`);
      if (!this.db.prepare('SELECT 1 FROM team_members WHERE team = ? AND owner = ?').get(team, owner)) {
        throw new GrantError(`team:${team}: owner ${owner} is not a member of that team`);
      }
    }
  }

  /** A `machine:<id>` grant only for an existing machine of the token's own owner. */
  private checkMachineGrants(grants: readonly Grant[], owner: string): void {
    checkMachineGrant(grants);
    for (const id of machinesOf(grants)) {
      const m = this.db.prepare('SELECT owner FROM machines WHERE id = ?').get(id) as { owner: string } | undefined;
      if (!m) throw new GrantError(`machine:${id}: no such machine`);
      if (m.owner !== owner) throw new GrantError(`machine:${id}: the machine belongs to another owner`);
    }
  }

  revoke(label: string): boolean {
    const res = this.db
      .prepare('UPDATE tokens SET revoked_at = ? WHERE label = ? AND revoked_at IS NULL')
      .run(this.iso(), label);
    return Number(res.changes) === 1;
  }

  info(id: number): TokenInfo | undefined {
    const r = this.db.prepare('SELECT * FROM tokens WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? toInfo(r) : undefined;
  }

  list(includeRevoked = false): TokenInfo[] {
    const rows = this.db
      .prepare(`SELECT * FROM tokens ${includeRevoked ? '' : 'WHERE revoked_at IS NULL'} ORDER BY id`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(toInfo);
  }

  /** Tokens of one owner, oldest first. */
  ofOwner(owner: string, includeRevoked = false): TokenInfo[] {
    return this.list(includeRevoked).filter((t) => t.owner === owner);
  }

  /**
   * An owner revokes one of their own active tokens, never the one making the
   * call: `missing` for an unknown, revoked or another owner's label.
   */
  revokeOwn(owner: string, label: string, currentTokenId: number): 'revoked' | 'missing' | 'current' {
    const t = this.ofOwner(owner).find((x) => x.label === label);
    if (!t) return 'missing';
    if (t.id === currentTokenId) return 'current';
    return this.revoke(label) ? 'revoked' : 'missing';
  }

  /** Whether the owner has an active console token (an `owner:<id>` grant). */
  hasConsole(owner: string): boolean {
    return this.ofOwner(owner).some((t) => isConsole(t.grants));
  }

  /** The caller for a bearer, or undefined for a wrong, short or revoked one. */
  authenticate(bearer: string | undefined): Caller | undefined {
    if (!bearer || bearer.length < 32 || bearer.length > 200) return undefined;
    const r = this.db
      .prepare('SELECT * FROM tokens WHERE hash = ? AND revoked_at IS NULL')
      .get(hashToken(bearer)) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    const info = toInfo(r);
    const now = this.now();
    if (!info.lastUsedAt || Date.parse(info.lastUsedAt) <= now - LAST_USED_EVERY_MS) {
      this.db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(new Date(now).toISOString(), info.id);
    }
    return { tokenId: info.id, key: `token:${info.id}`, label: info.label, owner: info.owner, grants: info.grants };
  }
}

function toOwner(r: Record<string, unknown>): Owner {
  return {
    id: String(r.id),
    name: String(r.name),
    telegramUser: (r.telegram_user as string | null) ?? null,
    tz: String(r.tz),
    createdAt: String(r.created_at),
  };
}

function toInfo(r: Record<string, unknown>): TokenInfo {
  return {
    id: Number(r.id),
    label: String(r.label),
    owner: String(r.owner),
    grants: JSON.parse(String(r.grants)) as Grant[],
    createdAt: String(r.created_at),
    revokedAt: (r.revoked_at as string | null) ?? null,
    lastUsedAt: (r.last_used_at as string | null) ?? null,
  };
}
