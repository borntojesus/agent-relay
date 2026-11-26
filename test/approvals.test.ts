import { describe, expect, it } from 'vitest';
import {
  APPROVAL_CALLBACK,
  ApprovalForbiddenError,
  ApprovalInputError,
  parseApprovalRequest,
  tierFor,
} from '../src/approvals/actions.ts';
import { NotStartedError } from '../src/approvals/channel.ts';
import { world } from './helpers.ts';

const req = (over: Record<string, unknown> = {}) =>
  parseApprovalRequest({ project: 'web-app', action: 'deploy', summary: 'deploy v2 to prod', requester: 'mac-a', ...over });

function buttons(data: string[]) {
  return data.map((d) => {
    const m = APPROVAL_CALLBACK.exec(d)!;
    return { id: m[1]!, nonce: m[2]!, act: m[3] as 'a' | 'r' | 'd' };
  });
}

describe('policy', () => {
  it('takes the strictest of action, declared risk and client work; unknown actions are big', () => {
    expect(tierFor({ action: 'read', project: 'p' })).toBe('read');
    expect(tierFor({ action: 'task.create', project: 'p' })).toBe('small');
    expect(tierFor({ action: 'task.create', project: 'p', risk: 'big' })).toBe('big');
    expect(tierFor({ action: 'deploy', project: 'p', risk: 'read' })).toBe('big');
    expect(tierFor({ action: 'read', project: 'p', clientProject: true })).toBe('big');
    expect(tierFor({ action: 'something.new', project: 'p' })).toBe('big');
    expect(tierFor({ action: 'note.add', project: 'client-site' }, /^client-/)).toBe('big');
  });

  it('validates the request body', () => {
    expect(() => parseApprovalRequest(null)).toThrow(ApprovalInputError);
    expect(() => req({ action: 'Deploy!' })).toThrow(/action/);
    expect(() => req({ risk: 'huge' })).toThrow(/risk/);
    expect(() => req({ ttlMinutes: 0 })).toThrow(/ttlMinutes/);
    expect(() => req({ ttlMinutes: 121 })).toThrow(/ttlMinutes/);
    expect(() => req({ summary: '' })).toThrow(/summary/);
    expect(req({ telegram: true }).card).toBe(true);
  });
});

describe('action approvals', () => {
  it('approves a read by policy with no card', async () => {
    const w = world();
    const a = w.agent('mac-a', 'alice', 'approval:ops:w');
    const v = await w.relay.approvals.create(a.caller, req({ action: 'status' }));
    expect(v).toMatchObject({ status: 'approved', decidedVia: 'policy', decidedBy: 'policy', scope: 'ops' });
    expect(w.ch.alice!.sent).toHaveLength(0);
  });

  it('a big request goes to the owner card, and only the owner\'s tap decides it', async () => {
    const w = world();
    const a = w.agent('mac-a', 'alice', 'approval:ops:w');
    const v = await w.relay.approvals.create(a.caller, req());
    expect(v.status).toBe('pending');
    expect(w.ch.alice!.cards()[0]!.text).toContain('BIG');
    expect(w.ch.bob!.sent).toHaveLength(0);
    await expect(w.relay.approvals.decideInApp(a.caller, v.id, 'approve')).rejects.toThrow(ApprovalForbiddenError);

    const [ok] = buttons(w.ch.alice!.lastButtons());
    // Bob's bot routes the same data as owner bob: unknown.
    expect((await w.relay.approvals.tap('bob', ok!.id, ok!.nonce, 'a', '222')).kind).toBe('unknown');
    expect((await w.relay.approvals.tap('alice', ok!.id, ok!.nonce, 'a', '111')).kind).toBe('decided');
    expect(w.relay.approvals.status(a.caller.key, v.id)).toMatchObject({ status: 'approved', decidedVia: 'owner', decidedBy: 'owner:111' });
    // Replay of the same tap changes nothing.
    const again = await w.relay.approvals.tap('alice', ok!.id, ok!.nonce, 'r', '111');
    expect(again.kind).toBe('already');
    expect(w.relay.approvals.status(a.caller.key, v.id)!.status).toBe('approved');
  });

  it('ignores a wrong nonce', async () => {
    const w = world();
    const a = w.agent('mac-a', 'alice', 'approval:ops:w');
    const v = await w.relay.approvals.create(a.caller, req());
    expect((await w.relay.approvals.tap('alice', v.id, 'ffffffffffffffff', 'a', '111')).kind).toBe('unknown');
    expect(w.relay.approvals.status(a.caller.key, v.id)!.status).toBe('pending');
  });

  it('shows details on request and keeps it pending', async () => {
    const w = world();
    const a = w.agent('mac-a', 'alice', 'approval:ops:w');
    await w.relay.approvals.create(a.caller, req({ effect: { details: 'line one\nline two' } }));
    const bs = buttons(w.ch.alice!.lastButtons());
    const d = bs.find((b) => b.act === 'd')!;
    const t = await w.relay.approvals.tap('alice', d.id, d.nonce, 'd', '111');
    expect(t.kind).toBe('details');
    if (t.kind === 'details') expect(t.card).toContain('line two');
  });

  it('fails closed on expiry: a late tap is expired, never approved', async () => {
    const w = world();
    const a = w.agent('mac-a', 'alice', 'approval:ops:w');
    const v = await w.relay.approvals.create(a.caller, req({ ttlMinutes: 1 }));
    w.clock.t += 61_000;
    expect(w.relay.approvals.status(a.caller.key, v.id)!.status).toBe('expired');
    const [ok] = buttons(w.ch.alice!.lastButtons());
    expect((await w.relay.approvals.tap('alice', ok!.id, ok!.nonce, 'a', '111')).kind).toBe('expired');
    expect(w.relay.approvals.status(a.caller.key, v.id)).toMatchObject({ status: 'expired' });
  });

  it('a restart expires whatever was pending', async () => {
    const w = world();
    const a = w.agent('mac-a', 'alice', 'approval:ops:w');
    const v = await w.relay.approvals.create(a.caller, req());
    expect(await w.relay.approvals.start(60_000)).toBe(1);
    w.relay.approvals.stop();
    expect(w.relay.approvals.status(a.caller.key, v.id)).toMatchObject({ status: 'expired', decidedVia: 'restart' });
  });

  it('lets the app decide a small request, and edits a card if one was shown', async () => {
    const w = world();
    const a = w.agent('mac-a', 'alice', 'approval:ops:w');
    const quiet = await w.relay.approvals.create(a.caller, req({ action: 'task.create' }));
    expect(w.ch.alice!.sent).toHaveLength(0);
    const done = await w.relay.approvals.decideInApp(a.caller, quiet.id, 'approve');
    expect(done).toMatchObject({ status: 'approved', decidedVia: 'app', decidedBy: 'app:mac-a' });

    const carded = await w.relay.approvals.create(a.caller, req({ action: 'task.create', card: true }));
    expect(w.ch.alice!.cards()).toHaveLength(1);
    await w.relay.approvals.decideInApp(a.caller, carded.id, 'reject');
    expect(w.ch.alice!.edits.at(-1)!.text).toContain('in the app');
    await expect(w.relay.approvals.decideInApp(a.caller, carded.id, 'maybe')).rejects.toThrow(ApprovalInputError);
  });

  it('keeps every token to its own requests and journal', async () => {
    const w = world();
    const a = w.agent('mac-a', 'alice', 'approval:ops:w');
    const b = w.agent('mac-b', 'alice', 'approval:ops:w');
    const v = await w.relay.approvals.create(a.caller, req());
    expect(w.relay.approvals.status(b.caller.key, v.id)).toBeUndefined();
    expect(await w.relay.approvals.decideInApp(b.caller, v.id, 'approve')).toBeUndefined();
    expect(w.relay.approvals.journal(a.caller.key)).toHaveLength(1);
    expect(w.relay.approvals.journal(b.caller.key)).toHaveLength(0);
  });

  it('rejects the request when the card cannot be delivered', async () => {
    const w = world();
    const a = w.agent('mac-a', 'alice', 'approval:ops:w');
    w.ch.alice!.fail = new NotStartedError('chat not found');
    await expect(w.relay.approvals.create(a.caller, req())).rejects.toThrow(/could not be delivered/);
    expect(w.relay.approvals.journal(a.caller.key)[0]).toMatchObject({ status: 'rejected', decidedVia: 'delivery_failed' });
  });

  it('needs a channel for a card', async () => {
    const w = world({ channels: ['bob'] });
    const a = w.agent('mac-a', 'alice', 'approval:ops:w');
    await expect(w.relay.approvals.create(a.caller, req())).rejects.toThrow(/approval channel/);
    // A read needs no card, so no channel either.
    expect((await w.relay.approvals.create(a.caller, req({ action: 'read' }))).status).toBe('approved');
  });

  it('checks the scope against the grants', async () => {
    const w = world();
    const one = w.agent('one', 'alice', 'approval:ops:w');
    const two = w.agent('two', 'alice', 'approval:ops:w', 'approval:web:w');
    const none = w.agent('none', 'alice', 'peer:team:rw');
    const wild = w.agent('wild', 'alice', 'approval:*:w');
    expect(w.relay.approvals.scopeFor(one.caller)).toBe('ops');
    expect(() => w.relay.approvals.scopeFor(one.caller, 'web')).toThrow(ApprovalForbiddenError);
    expect(() => w.relay.approvals.scopeFor(two.caller)).toThrow(/scope is required/);
    expect(w.relay.approvals.scopeFor(two.caller, 'web')).toBe('web');
    expect(() => w.relay.approvals.scopeFor(none.caller)).toThrow(/no approval scope/);
    expect(w.relay.approvals.scopeFor(wild.caller, 'anything')).toBe('anything');
  });

  it('treats configured projects as big', async () => {
    const w = world({ bigProjects: /^client-/ });
    const a = w.agent('mac-a', 'alice', 'approval:ops:w');
    const v = await w.relay.approvals.create(a.caller, req({ action: 'note.add', project: 'client-site' }));
    expect(v.tier).toBe('big');
  });
});
