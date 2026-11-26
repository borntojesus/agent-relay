import type { DatabaseSync } from 'node:sqlite';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { canSend, NAME, type Grant } from '../grants.ts';
import type { TokenStore } from '../tokens.ts';
import type { ChannelFor, Keyboard } from './channel.ts';
import type { OnPending } from '../push/types.ts';

/**
 * Approval requests for agents' actions. An agent says what it wants to do;
 * the relay decides the tier, and a big action only ever goes ahead after the
 * agent's owner taps Approve on the card in their own approval channel.
 *
 * Tiers: `read` is approved by policy at once; `small` (task, branch, draft)
 * may be decided by one call from the agent's app (`POST /approvals/:id/decide`)
 * or on a card; `big` (merge, deploy, publish, send, spend, delete, client
 * work, app review) is decided only by the owner's tap. An action type the
 * policy does not know is big. A declared risk raises the tier, never lowers it.
 *
 * Fail closed: a request is `approved` only through one of those paths. Past
 * its expiry it is `expired`, and every request still pending when the relay
 * starts is `expired` too (via `restart`). Callback data is
 * `apv:<id>:<nonce>:<a|r|d>`; the nonce is per card, the owner must match, and
 * the decision is a compare-and-set on `pending`, so a replayed, forged or
 * foreign button changes nothing. Every request and decision stays a year in
 * `action_approvals`, the journal the agent reads back.
 */

export type ApprovalTier = 'read' | 'small' | 'big';
export const APPROVAL_TIERS: readonly ApprovalTier[] = ['read', 'small', 'big'];
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export const APPROVAL_DEFAULT_TTL_MIN = 15;
export const APPROVAL_MAX_TTL_MIN = 120;
const SUMMARY_MAX = 300;
const FIELD_MAX = 200;
const DETAILS_MAX = 2500;
const REF_MAX = 64;
const KEEP_MS = 365 * 24 * 60 * 60 * 1000;

/** Action types the policy knows. Anything else is big. */
export const ACTION_TIERS: Readonly<Record<string, ApprovalTier>> = Object.freeze({
  read: 'read',
  status: 'read',
  search: 'read',
  digest: 'read',
  report: 'read',
  'task.create': 'small',
  'task.update': 'small',
  'task.comment': 'small',
  'branch.create': 'small',
  'draft.create': 'small',
  'note.add': 'small',
  merge: 'big',
  deploy: 'big',
  publish: 'big',
  send: 'big',
  spend: 'big',
  delete: 'big',
  'push.client': 'big',
  'app.review': 'big',
});

const rank = (t: ApprovalTier) => APPROVAL_TIERS.indexOf(t);
const max = (a: ApprovalTier, b: ApprovalTier) => (rank(a) >= rank(b) ? a : b);

/**
 * The tier the relay enforces: the strictest of the action's, the declared
 * risk and client work. `bigProjects` matches project names that are always
 * big (configured with RELAY_BIG_PROJECTS).
 */
export function tierFor(
  req: { action: string; risk?: ApprovalTier; clientProject?: boolean; project: string },
  bigProjects?: RegExp,
): ApprovalTier {
  let tier: ApprovalTier = ACTION_TIERS[req.action] ?? 'big';
  if (req.risk) tier = max(tier, req.risk);
  if (req.clientProject || bigProjects?.test(req.project)) tier = 'big';
  return tier;
}

export interface ApprovalEffect {
  diff?: string;
  recipient?: string;
  amount?: string;
  details?: string;
}

export interface ApprovalRequest {
  scope?: string;
  project: string;
  action: string;
  risk?: ApprovalTier;
  clientProject: boolean;
  summary: string;
  effect: ApprovalEffect;
  requester: string;
  ttlMinutes: number;
  /** Small tier: also put a card in the owner's channel (big always gets one). */
  card: boolean;
  ref?: string;
}

export interface ApprovalView {
  id: string;
  scope: string;
  project: string;
  action: string;
  tier: ApprovalTier;
  summary: string;
  effect: ApprovalEffect;
  requester: string;
  status: ApprovalStatus;
  /** owner (tap on the card), console (owner console), app (small only), policy (read), timeout, restart, delivery_failed. */
  decidedVia: string | null;
  /** `owner:<id>`, `app:<token label>`, `policy`, `relay`. */
  decidedBy: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  ref: string | null;
}

/** A request as the owner console sees it: the view plus the token that asked. */
export interface OwnerApproval extends ApprovalView {
  caller: string;
}

export const APPROVAL_STATUSES: readonly ApprovalStatus[] = ['pending', 'approved', 'rejected', 'expired'];

export class ApprovalInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalInputError';
  }
}

/** A decision on a request that is no longer pending (decided or expired); answers 409. */
export class ApprovalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalConflictError';
  }
}

export class ApprovalForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalForbiddenError';
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const clean = (s: string) => s.replace(CONTROL, '').trim();
const oneLine = (s: string) => clean(s.replace(/[\r\n\t]+/g, ' '));

function str(b: Record<string, unknown>, key: string, maxLen: number, required: boolean): string {
  const raw = b[key];
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw new ApprovalInputError(`${key} is required`);
    return '';
  }
  if (typeof raw !== 'string') throw new ApprovalInputError(`${key} must be a string`);
  const v = oneLine(raw);
  if (required && !v) throw new ApprovalInputError(`${key} is required`);
  if (v.length > maxLen) throw new ApprovalInputError(`${key} is longer than ${maxLen} characters`);
  return v;
}

/** Validates a body from REST or MCP into a request, or says what is wrong. */
export function parseApprovalRequest(body: unknown): ApprovalRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApprovalInputError('body must be a JSON object');
  const b = body as Record<string, unknown>;
  const scope = str(b, 'scope', 32, false).toLowerCase().replace(/^approval:/, '');
  if (scope && !NAME.test(scope)) throw new ApprovalInputError('scope is lowercase letters, digits and dashes, up to 32');
  const project = str(b, 'project', 80, true);
  const action = str(b, 'action', 40, true).toLowerCase();
  if (!/^[a-z][a-z0-9._-]*$/.test(action)) throw new ApprovalInputError('action is [a-z0-9._-], e.g. deploy, merge, task.create');
  let risk: ApprovalTier | undefined;
  if (b.risk !== undefined && b.risk !== null) {
    if (!APPROVAL_TIERS.includes(b.risk as ApprovalTier)) throw new ApprovalInputError('risk is read, small or big');
    risk = b.risk as ApprovalTier;
  }
  const summary = str(b, 'summary', SUMMARY_MAX, true);
  const requester = str(b, 'requester', 60, true);
  const e = (b.effect ?? {}) as Record<string, unknown>;
  if (typeof e !== 'object' || Array.isArray(e)) throw new ApprovalInputError('effect is {diff?, recipient?, amount?, details?}');
  const effect: ApprovalEffect = {};
  for (const k of ['diff', 'recipient', 'amount'] as const) {
    const v = str(e, k, FIELD_MAX, false);
    if (v) effect[k] = v;
  }
  if (e.details !== undefined && e.details !== null) {
    if (typeof e.details !== 'string') throw new ApprovalInputError('effect.details must be a string');
    const d = clean(e.details);
    if (d.length > DETAILS_MAX) throw new ApprovalInputError(`effect.details is longer than ${DETAILS_MAX} characters`);
    if (d) effect.details = d;
  }
  let ttlMinutes = APPROVAL_DEFAULT_TTL_MIN;
  if (b.ttlMinutes !== undefined && b.ttlMinutes !== null) {
    const t = b.ttlMinutes;
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > APPROVAL_MAX_TTL_MIN) {
      throw new ApprovalInputError(`ttlMinutes is a whole number from 1 to ${APPROVAL_MAX_TTL_MIN}`);
    }
    ttlMinutes = t;
  }
  const ref = str(b, 'ref', REF_MAX, false) || undefined;
  return {
    ...(scope ? { scope } : {}),
    project,
    action,
    ...(risk ? { risk } : {}),
    clientProject: b.clientProject === true,
    summary,
    effect,
    requester,
    ttlMinutes,
    card: b.card === true || b.telegram === true,
    ...(ref ? { ref } : {}),
  };
}

const TIER_LABEL: Record<ApprovalTier, string> = { read: 'READ', small: 'SMALL', big: 'BIG' };

function clock(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
}

/** The card as the owner sees it: tier, action, project, exactly what happens. */
export function approvalCardText(
  row: Pick<ApprovalView, 'scope' | 'tier' | 'action' | 'project' | 'summary' | 'effect' | 'requester' | 'expiresAt'> & { caller: string },
  tz = 'UTC',
  withDetails = false,
): string {
  const lines = [
    `🛡 ${row.scope} · ${TIER_LABEL[row.tier]} · ${row.action}`,
    `Project: ${row.project}`,
    `Asked by: ${row.requester} (${row.caller})`,
    '',
    row.summary,
  ];
  const fx: string[] = [];
  if (row.effect.diff) fx.push(`Diff: ${row.effect.diff}`);
  if (row.effect.recipient) fx.push(`To: ${row.effect.recipient}`);
  if (row.effect.amount) fx.push(`Amount: ${row.effect.amount}`);
  if (fx.length) lines.push('', 'What happens:', ...fx);
  if (withDetails && row.effect.details) lines.push('', 'Details:', row.effect.details);
  lines.push('', `Valid until ${clock(row.expiresAt, tz)} (${tz}). No answer = rejected.`);
  return lines.join('\n');
}

export function approvalKeyboard(id: string, nonce: string, details: boolean): Keyboard {
  const row = [
    { text: '✅ Approve', callback_data: `apv:${id}:${nonce}:a` },
    { text: '✖️ Reject', callback_data: `apv:${id}:${nonce}:r` },
  ];
  return details
    ? { inline_keyboard: [row, [{ text: 'Show details', callback_data: `apv:${id}:${nonce}:d` }]] }
    : { inline_keyboard: [row] };
}

export const APPROVAL_CALLBACK = /^apv:([0-9a-f]{24}):([0-9a-f]{16}):([ard])$/;

/** What a tap did, for the channel to answer and rewrite the card. */
export type ApprovalTap =
  | { kind: 'decided'; said: string; card: string }
  | { kind: 'details'; card: string; keyboard: Keyboard }
  | { kind: 'already'; said: string; card?: string }
  | { kind: 'expired'; card: string }
  | { kind: 'unknown' };

export interface DecidedNotice {
  id: string;
  scope: string;
  owner: string;
  callerKey: string;
  callerLabel: string;
  project: string;
  action: string;
  tier: ApprovalTier;
  status: Exclude<ApprovalStatus, 'pending'>;
  via: string;
  ref: string | null;
}

export interface ApprovalCaller {
  key: string;
  label: string;
  owner: string;
  grants: readonly Grant[];
}

export interface ActionApprovalsDeps {
  db: DatabaseSync;
  tokens: TokenStore;
  channelFor: ChannelFor;
  bigProjects?: RegExp;
  now?: () => Date;
  log?: (line: string) => void;
  onDecided?: (n: DecidedNotice) => void;
  /** Told when a request becomes pending for its owner (push). Never awaited. */
  onPending?: OnPending;
}

interface Row {
  id: string;
  nonce: string;
  scope: string;
  owner: string;
  caller_key: string;
  caller_label: string;
  project: string;
  action: string;
  tier: ApprovalTier;
  declared_risk: string | null;
  client: number;
  summary: string;
  effect: string;
  requester: string;
  ref: string | null;
  status: ApprovalStatus;
  decided_via: string | null;
  decided_by: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  message_id: number | null;
}

const SAID: Record<Exclude<ApprovalStatus, 'pending'>, string> = {
  approved: '✅ Approved',
  rejected: '✖️ Rejected',
  expired: '⌛ Expired, rejected',
};

function sameNonce(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class ActionApprovals {
  private readonly db: DatabaseSync;
  private readonly deps: ActionApprovalsDeps;
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(deps: ActionApprovalsDeps) {
    this.deps = deps;
    this.db = deps.db;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private tz(owner: string): string {
    return this.deps.tokens.owner(owner)?.tz ?? 'UTC';
  }

  /** The scopes this caller may ask in (send on `approval:<scope>`), or the one it named. */
  scopeFor(caller: ApprovalCaller, asked?: string): string {
    if (asked) {
      if (!canSend(caller.grants, `approval:${asked}`)) throw new ApprovalForbiddenError(`this token has no send on approval:${asked}`);
      return asked;
    }
    const named = caller.grants.filter((g) => g.send && g.channel.startsWith('approval:') && g.channel !== 'approval:*');
    if (named.length === 1) return named[0]!.channel.slice('approval:'.length);
    if (!named.length && !canSend(caller.grants, 'approval:*')) throw new ApprovalForbiddenError('this token has no approval scope');
    throw new ApprovalInputError('scope is required: this token may ask in more than one');
  }

  /** Fails every request still pending from before this start and starts the sweep. Call once at boot. */
  async start(sweepMs = 30_000): Promise<number> {
    const n = await this.closePending(`status = 'pending'`, [], 'restart');
    this.sweeper = setInterval(() => void this.sweep().catch(() => undefined), sweepMs);
    this.sweeper.unref?.();
    return n;
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  sweep(): Promise<number> {
    return this.closePending(`status = 'pending' AND expires_at <= ?`, [this.now().toISOString()], 'timeout');
  }

  private async closePending(where: string, params: string[], via: 'restart' | 'timeout'): Promise<number> {
    const rows = this.db.prepare(`SELECT * FROM action_approvals WHERE ${where}`).all(...params) as unknown as Row[];
    let n = 0;
    const at = this.now().toISOString();
    for (const row of rows) {
      const changed = this.db
        .prepare(`UPDATE action_approvals SET status = 'expired', decided_via = ?, decided_by = 'relay', decided_at = ? WHERE id = ? AND status = 'pending'`)
        .run(via, at, row.id).changes;
      if (!changed) continue;
      n++;
      this.journalLine(row, 'expired', via);
      this.notice(row, 'expired', via);
      const ch = this.deps.channelFor(row.owner);
      if (row.message_id && ch) {
        const why = via === 'restart' ? '⌛ Relay restarted, rejected' : SAID.expired;
        await ch.edit(row.message_id, `${this.cardOf(row)}\n\n${why}`).catch(() => undefined);
      }
    }
    return n;
  }

  private journalLine(row: Row, status: string, via: string, by?: string): void {
    this.deps.log?.(`[approvals] ${row.id} ${row.caller_label} ${row.scope} ${row.tier} ${row.action} ${row.project}: ${status} via ${via}${by ? ` by ${by}` : ''}`);
  }

  private notice(row: Row, status: Exclude<ApprovalStatus, 'pending'>, via: string): void {
    this.deps.onDecided?.({
      id: row.id,
      scope: row.scope,
      owner: row.owner,
      callerKey: row.caller_key,
      callerLabel: row.caller_label,
      project: row.project,
      action: row.action,
      tier: row.tier,
      status,
      via,
      ref: row.ref,
    });
  }

  private cardOf(row: Row, withDetails = false): string {
    return approvalCardText(
      {
        scope: row.scope,
        tier: row.tier,
        action: row.action,
        project: row.project,
        summary: row.summary,
        effect: JSON.parse(row.effect) as ApprovalEffect,
        requester: row.requester,
        expiresAt: row.expires_at,
        caller: row.caller_label,
      },
      this.tz(row.owner),
      withDetails,
    );
  }

  /**
   * Stores the request and, for big (or small with `card`), sends the card to
   * the caller's owner. Read is approved by policy at once. A card the channel
   * refused leaves the request `rejected`, so nothing runs.
   */
  async create(caller: ApprovalCaller, req: ApprovalRequest): Promise<ApprovalView> {
    const scope = this.scopeFor(caller, req.scope);
    const tier = tierFor(req, this.deps.bigProjects);
    const card = tier === 'big' || (tier === 'small' && req.card);
    const ch = this.deps.channelFor(caller.owner);
    if (card && !ch) throw new Error('approval cards need an approval channel for this owner (RELAY_BOT_TOKEN_<OWNER>)');
    const now = this.now();
    const id = randomBytes(12).toString('hex');
    const nonce = randomBytes(8).toString('hex');
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + req.ttlMinutes * 60_000).toISOString();
    this.db.prepare(`DELETE FROM action_approvals WHERE created_at < ?`).run(new Date(now.getTime() - KEEP_MS).toISOString());
    const auto = tier === 'read';
    this.db
      .prepare(
        `INSERT INTO action_approvals (id, nonce, scope, owner, caller_key, caller_label, project, action, tier, declared_risk,
           client, summary, effect, requester, ref, status, decided_via, decided_by, created_at, expires_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        nonce,
        scope,
        caller.owner,
        caller.key,
        caller.label,
        req.project,
        req.action,
        tier,
        req.risk ?? null,
        req.clientProject ? 1 : 0,
        req.summary,
        JSON.stringify(req.effect),
        req.requester,
        req.ref ?? null,
        auto ? 'approved' : 'pending',
        auto ? 'policy' : null,
        auto ? 'policy' : null,
        createdAt,
        expiresAt,
        auto ? createdAt : null,
      );
    const row = this.row(id)!;
    if (auto) {
      this.journalLine(row, 'approved', 'policy');
      this.notice(row, 'approved', 'policy');
      return this.view(row);
    }
    this.journalLine(row, 'pending', card ? 'card' : 'app');
    this.deps.onPending?.(caller.owner, { kind: 'approval', id });
    if (card) {
      try {
        const { messageId } = await ch!.send(this.cardOf(row), approvalKeyboard(id, nonce, Boolean(req.effect.details)));
        this.db.prepare(`UPDATE action_approvals SET message_id = ? WHERE id = ?`).run(messageId, id);
      } catch (err) {
        this.db
          .prepare(`UPDATE action_approvals SET status = 'rejected', decided_via = 'delivery_failed', decided_by = 'relay', decided_at = ? WHERE id = ? AND status = 'pending'`)
          .run(this.now().toISOString(), id);
        this.deps.log?.(`[approvals] ${id}: card delivery failed: ${err instanceof Error ? err.message : String(err)}`);
        this.notice(row, 'rejected', 'delivery_failed');
        throw new Error('the approval card could not be delivered to the owner; the request is rejected');
      }
    }
    return this.view(this.row(id)!);
  }

  private row(id: string): Row | undefined {
    if (!/^[0-9a-f]{24}$/.test(id)) return undefined;
    return this.db.prepare(`SELECT * FROM action_approvals WHERE id = ?`).get(id) as Row | undefined;
  }

  private view(row: Row): ApprovalView {
    const late = row.status === 'pending' && this.now().toISOString() >= row.expires_at;
    return {
      id: row.id,
      scope: row.scope,
      project: row.project,
      action: row.action,
      tier: row.tier,
      summary: row.summary,
      effect: JSON.parse(row.effect) as ApprovalEffect,
      requester: row.requester,
      status: late ? 'expired' : row.status,
      decidedVia: late ? 'timeout' : row.decided_via,
      decidedBy: late ? 'relay' : row.decided_by,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      decidedAt: row.decided_at,
      ref: row.ref,
    };
  }

  /** The caller's own request; undefined for an unknown id or another token's. */
  status(callerKey: string, id: string): ApprovalView | undefined {
    const row = this.row(id);
    if (!row || row.caller_key !== callerKey) return undefined;
    return this.view(row);
  }

  /** The journal of this caller, newest first. */
  journal(callerKey: string, opts: { limit?: number; since?: string } = {}): ApprovalView[] {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
    const since = opts.since && !Number.isNaN(Date.parse(opts.since)) ? new Date(opts.since).toISOString() : '';
    const rows = this.db
      .prepare(`SELECT * FROM action_approvals WHERE caller_key = ? AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(callerKey, since, limit) as unknown as Row[];
    return rows.map((r) => this.view(r));
  }

  private ownerView(row: Row): OwnerApproval {
    return { ...this.view(row), caller: row.caller_label };
  }

  /** The journal of every agent of one owner, newest first; `status` filters. */
  async ownerJournal(owner: string, opts: { status?: string; limit?: number } = {}): Promise<OwnerApproval[]> {
    await this.sweep();
    if (opts.status !== undefined && !APPROVAL_STATUSES.includes(opts.status as ApprovalStatus)) {
      throw new ApprovalInputError(`status is one of ${APPROVAL_STATUSES.join(', ')}`);
    }
    const limit = Math.min(Math.max(Math.trunc(Number.isFinite(opts.limit) ? opts.limit! : 50), 1), 200);
    const rows = (
      opts.status
        ? this.db
            .prepare(`SELECT * FROM action_approvals WHERE owner = ? AND status = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
            .all(owner, opts.status, limit)
        : this.db.prepare(`SELECT * FROM action_approvals WHERE owner = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(owner, limit)
    ) as unknown as Row[];
    return rows.map((r) => this.ownerView(r));
  }

  /** Requests of the owner's agents still waiting for a decision, oldest first. */
  async ownerPending(owner: string): Promise<OwnerApproval[]> {
    await this.sweep();
    const rows = this.db
      .prepare(`SELECT * FROM action_approvals WHERE owner = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at, rowid`)
      .all(owner, this.now().toISOString()) as unknown as Row[];
    return rows.map((r) => this.ownerView(r));
  }

  /**
   * The owner's decision from the console, any tier. Undefined for an unknown
   * id or another owner's request; ApprovalConflictError when it is no longer
   * pending. A Telegram card of the request is rewritten "(in the app)".
   */
  async decideByOwner(owner: string, id: string, decision: unknown): Promise<OwnerApproval | undefined> {
    const row = this.row(id);
    if (!row || row.owner !== owner) return undefined;
    if (decision !== 'approve' && decision !== 'reject') throw new ApprovalInputError('decision is approve or reject');
    if (!(await this.decide(row, decision === 'approve' ? 'approved' : 'rejected', 'console', `owner:${owner}`))) {
      await this.sweep();
      throw new ApprovalConflictError(`request ${id} is no longer pending (${this.view(this.row(id)!).status})`);
    }
    return this.ownerView(this.row(id)!);
  }

  /** A decision from the agent's own app, only for its small requests. Big ones are the owner's alone. */
  async decideInApp(caller: { key: string; label: string }, id: string, decision: unknown): Promise<ApprovalView | undefined> {
    const row = this.row(id);
    if (!row || row.caller_key !== caller.key) return undefined;
    if (decision !== 'approve' && decision !== 'reject') throw new ApprovalInputError('decision is approve or reject');
    if (row.tier !== 'small') throw new ApprovalForbiddenError(`a ${row.tier} request is decided only by the owner on the card`);
    await this.decide(row, decision === 'approve' ? 'approved' : 'rejected', 'app', `app:${caller.label}`);
    return this.view(this.row(id)!);
  }

  private async decide(row: Row, status: 'approved' | 'rejected', via: string, by: string): Promise<boolean> {
    const now = this.now().toISOString();
    const changed = this.db
      .prepare(`UPDATE action_approvals SET status = ?, decided_via = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ?`)
      .run(status, via, by, now, row.id, now).changes;
    if (!changed) return false;
    this.journalLine(row, status, via, by);
    this.notice(row, status, via);
    const ch = this.deps.channelFor(row.owner);
    if (via !== 'owner' && row.message_id && ch) {
      await ch.edit(row.message_id, `${this.cardOf(row)}\n\n${SAID[status]} (in the app)`).catch(() => undefined);
    }
    return true;
  }

  /**
   * The owner's tap on a card, routed by the channel that belongs to `owner`.
   * A card of another owner, or a wrong nonce, is unknown.
   */
  async tap(owner: string, id: string, nonce: string, action: 'a' | 'r' | 'd', actor: string): Promise<ApprovalTap> {
    const row = this.row(id);
    if (!row || row.owner !== owner || !sameNonce(row.nonce, nonce)) return { kind: 'unknown' };
    if (action === 'd') {
      if (row.status !== 'pending') return this.closedTap(row);
      if (this.now().toISOString() >= row.expires_at) {
        await this.sweep();
        return { kind: 'expired', card: `${this.cardOf(row)}\n\n${SAID.expired}` };
      }
      return { kind: 'details', card: this.cardOf(row, true), keyboard: approvalKeyboard(id, nonce, false) };
    }
    const status = action === 'a' ? 'approved' : 'rejected';
    if (await this.decide(row, status, 'owner', `owner:${actor}`)) {
      return { kind: 'decided', said: SAID[status], card: `${this.cardOf(row)}\n\n${SAID[status]}` };
    }
    const now = this.row(id)!;
    if (now.status !== 'pending') return this.closedTap(now);
    await this.sweep();
    return { kind: 'expired', card: `${this.cardOf(row)}\n\n${SAID.expired}` };
  }

  private closedTap(row: Row): ApprovalTap {
    if (row.status === 'expired') return { kind: 'expired', card: `${this.cardOf(row)}\n\n${SAID.expired}` };
    const said = SAID[row.status as 'approved' | 'rejected'];
    return { kind: 'already', said: `Already decided: ${said}`, card: `${this.cardOf(row)}\n\n${said}` };
  }
}
