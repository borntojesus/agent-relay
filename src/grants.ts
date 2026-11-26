/**
 * A token reaches only four kinds of channel:
 *
 * - `peer:<room>` (or `peer:*`): read and post in a room;
 * - `approval:<scope>` (or `approval:*`): ask for action approvals in a scope
 *   (send) and read its own requests and journal (read);
 * - `team:<id>`: read and post in every room of that team, only while the
 *   token's owner is a member of it (checked when the token is made and on
 *   every use). Never `team:*`;
 * - `owner:<id>`: the owner console (docs/console-api.md). Read sees everything
 *   of that owner, send decides and revokes. Never `owner:*`, only the token's
 *   own owner, and always the token's only grant (see `checkOwnerGrant`);
 * - `machine:<id>`: a worker on one of the owner's machines (docs/worker-api.md),
 *   always rw, never `machine:*`, never next to `owner:`, `team:` or `peer:`,
 *   at most one per token; the machine must belong to the token's owner.
 *
 * Nothing else exists, so a grant on anything else is refused when a token is
 * made. Read and send are separate rights.
 */
export interface Grant {
  channel: string;
  read: boolean;
  send: boolean;
}

export const GRANT_KINDS = ['peer', 'approval', 'team', 'owner', 'machine'] as const;
export type GrantKind = (typeof GRANT_KINDS)[number];

/** A room or scope name: lowercase, digits and dashes, up to 32. */
export const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const CHANNEL = /^(peer|approval):([a-z0-9][a-z0-9-]{0,31}|\*)$|^(owner|team|machine):[a-z0-9][a-z0-9-]{0,31}$/;

export class GrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrantError';
  }
}

/** Validates and normalises a list of grants; throws on anything but peer/approval. */
export function parseGrants(raw: unknown): Grant[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new GrantError('grants is a non-empty list');
  const out = new Map<string, Grant>();
  for (const g of raw) {
    if (!g || typeof g !== 'object') throw new GrantError('a grant is {channel, read, send}');
    const r = g as Record<string, unknown>;
    const channel = String(r.channel ?? '').trim().toLowerCase();
    if (!CHANNEL.test(channel)) {
      if (channel === 'owner:*') throw new GrantError('owner:* is not a grant: a console token is for one owner, owner:<id>');
      if (channel === 'team:*') throw new GrantError('team:* is not a grant: name the team, team:<id>');
      if (channel === 'machine:*') throw new GrantError('machine:* is not a grant: a worker token is for one machine, machine:<id>');
      throw new GrantError(`unknown channel ${JSON.stringify(channel)}: use peer:<room>, approval:<scope>, team:<id>, owner:<id> or machine:<id>`);
    }
    const read = r.read === true;
    const send = r.send === true;
    if (!read && !send) throw new GrantError(`${channel}: a grant needs read, send or both`);
    const prev = out.get(channel);
    out.set(channel, { channel, read: read || Boolean(prev?.read), send: send || Boolean(prev?.send) });
  }
  return [...out.values()];
}

/**
 * Short form for the CLI: `peer:ops:rw`, `approval:ci:s`. The last part is
 * any of r (read) and w/s (send).
 */
export function parseGrantSpec(spec: string): Grant {
  const m = /^(peer|approval|team|owner|machine):([a-z0-9][a-z0-9-]{0,31}|\*):([rws]{1,3})$/.exec(spec.trim().toLowerCase());
  if (!m) throw new GrantError(`grant ${JSON.stringify(spec)}: use peer:<room>:rw, approval:<scope>:rs, team:<id>:rw, owner:<id>:rw or machine:<id>:rw`);
  if (m[1] === 'machine' && m[2] === '*') throw new GrantError('machine:* is not a grant: a worker token is for one machine, machine:<id>');
  if (m[1] === 'owner' && m[2] === '*') throw new GrantError('owner:* is not a grant: a console token is for one owner, owner:<id>');
  if (m[1] === 'team' && m[2] === '*') throw new GrantError('team:* is not a grant: name the team, team:<id>');
  const rights = m[3]!;
  return {
    channel: `${m[1]}:${m[2]}`,
    read: rights.includes('r'),
    send: rights.includes('w') || rights.includes('s'),
  };
}

function matches(grant: string, channel: string): boolean {
  if (grant === channel) return true;
  const [kind, name] = grant.split(':');
  return name === '*' && channel.startsWith(`${kind}:`);
}

export function canRead(grants: readonly Grant[], channel: string): boolean {
  return grants.some((g) => g.read && matches(g.channel, channel));
}

export function canSend(grants: readonly Grant[], channel: string): boolean {
  return grants.some((g) => g.send && matches(g.channel, channel));
}

/** The scope names a token may ask approvals in (send on `approval:<scope>`), from a known list. */
export function scopesOf(grants: readonly Grant[], kind: GrantKind, known: readonly string[], right: 'read' | 'send'): string[] {
  const check = right === 'read' ? canRead : canSend;
  const explicit = grants
    .filter((g) => g.channel.startsWith(`${kind}:`) && !g.channel.endsWith(':*'))
    .map((g) => g.channel.slice(kind.length + 1));
  return [...new Set([...known, ...explicit])].filter((n) => check(grants, `${kind}:${n}`)).sort();
}

/** The team ids named by `team:<id>` grants (any right). */
export function teamsOf(grants: readonly Grant[]): string[] {
  return [...new Set(grants.filter((g) => g.channel.startsWith('team:')).map((g) => g.channel.slice(5)))].sort();
}

/** True when the grants are a console token's (an `owner:` grant). */
export function isConsole(grants: readonly Grant[]): boolean {
  return grants.some((g) => g.channel.startsWith('owner:'));
}

/**
 * The console rules for a token of `owner`: an `owner:` grant names that owner
 * and is the token's only grant (a console is never also an agent, so it is
 * never a room member and never changes a room's gate).
 */
export function checkOwnerGrant(grants: readonly Grant[], owner: string): void {
  const own = grants.filter((g) => g.channel.startsWith('owner:'));
  if (!own.length) return;
  for (const g of own) {
    if (g.channel !== `owner:${owner}`) throw new GrantError(`${g.channel}: a console grant names the token's own owner (owner:${owner})`);
  }
  if (grants.length !== 1) throw new GrantError('an owner: grant must be the only grant of its token');
}

/** The machine ids named by `machine:<id>` grants. */
export function machinesOf(grants: readonly Grant[]): string[] {
  return [...new Set(grants.filter((g) => g.channel.startsWith('machine:')).map((g) => g.channel.slice(8)))].sort();
}

/** True when the grants are a worker token's (a `machine:` grant). */
export function isWorker(grants: readonly Grant[]): boolean {
  return grants.some((g) => g.channel.startsWith('machine:'));
}

/**
 * The worker rules that need no database: one `machine:` grant, read and send,
 * never next to `owner:`, `team:` or `peer:`. That the machine exists and
 * belongs to the token's owner is checked in `tokens.create`.
 */
export function checkMachineGrant(grants: readonly Grant[]): void {
  const own = grants.filter((g) => g.channel.startsWith('machine:'));
  if (!own.length) return;
  if (own.length > 1) throw new GrantError('a worker token is for one machine: one machine:<id> grant');
  if (!own[0]!.read || !own[0]!.send) throw new GrantError(`${own[0]!.channel}: a worker grant is read and send (machine:<id>:rw)`);
  const other = grants.find((g) => /^(owner|team|peer):/.test(g.channel));
  if (other) throw new GrantError(`${other.channel}: a machine: grant cannot sit next to owner:, team: or peer: grants`);
}
