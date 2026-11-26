import { describe, expect, it } from 'vitest';
import { NotStartedError } from '../src/approvals/channel.ts';
import { formatUnreadText, MESSAGE_CALLBACK, RoomInputError, RoomRateError } from '../src/rooms/service.ts';
import { flush, world } from './helpers.ts';

/** Two Macs and a phone agent of alice share `team`; `shared` also has bob's agent. */
function setup() {
  const w = world();
  const macA = w.agent('mac-a', 'alice', 'peer:team:rw', 'peer:shared:rw');
  const macB = w.agent('mac-b', 'alice', 'peer:team:rw', 'peer:shared:rw');
  const phone = w.agent('phone', 'alice', 'peer:team:rw');
  const bobs = w.agent('bob-agent', 'bob', 'peer:shared:rw');
  const t = (a: { caller: Parameters<typeof w.relay.rooms.for>[0] }) => w.relay.rooms.for(a.caller)!;
  return { w, macA, macB, phone, bobs, t };
}

function tap(w: ReturnType<typeof world>, owner: string, data: string, by = 'owner:test') {
  const m = MESSAGE_CALLBACK.exec(data)!;
  return w.relay.rooms.decide(owner, Number(m[1]), m[2]!, m[3] === 'a' ? 'approve' : 'reject', by);
}

describe('multi-party room, one owner', () => {
  it('delivers at once with no card when every member belongs to the poster\'s owner', async () => {
    const { w, macA, t } = setup();
    const r = await t(macA).post({ room: 'team', thread: 'build', text: 'build is green' });
    expect(r.status).toBe('delivered');
    expect(w.ch.alice!.sent).toHaveLength(0);
    expect(w.ch.bob!.sent).toHaveLength(0);
  });

  it('keeps read state per token: three agents of one owner each see and ack on their own', async () => {
    const { macA, macB, phone, t } = setup();
    await t(macA).post({ room: 'team', thread: 'build', text: 'one' });
    await t(macA).post({ room: 'team', thread: 'build', text: 'two' });
    expect(t(macA).unread({ room: 'team' }).unread).toBe(0);
    expect(t(macB).unread({ room: 'team' }).messages.map((m) => m.text)).toEqual(['one', 'two']);
    expect(t(phone).unread({ room: 'team' }).unread).toBe(2);

    expect(t(macB).ack({ room: 'team', all: true }).acknowledged).toBe(2);
    expect(t(macB).unread({ room: 'team' }).unread).toBe(0);
    // mac-b reading does not mark it read for the phone.
    expect(t(phone).unread({ room: 'team' }).unread).toBe(2);

    const first = t(phone).unread({ room: 'team' }).messages[0]!;
    t(phone).ack({ room: 'team', ids: [first.id] });
    expect(t(phone).unread({ room: 'team' }).unread).toBe(1);
    const hist = t(macA).read({ room: 'team', thread: 'build' }).messages;
    expect(hist[0]!.readBy.sort()).toEqual(['mac-b', 'phone']);
    expect(hist[1]!.readBy).toEqual(['mac-b']);
  });

  it('shows thread summaries with the caller\'s own unread count', async () => {
    const { macA, macB, t } = setup();
    await t(macA).post({ room: 'team', thread: 'build', text: 'a' });
    await t(macB).post({ room: 'team', thread: 'deploy', text: 'b' });
    const forA = t(macA).threads({ room: 'team' }).threads;
    expect(forA.map((x) => [x.thread, x.unread])).toEqual([
      ['deploy', 1],
      ['build', 0],
    ]);
  });

  it('acks a thread up to an id only', async () => {
    const { macA, macB, t } = setup();
    const a = await t(macA).post({ room: 'team', thread: 'build', text: 'a' });
    await t(macA).post({ room: 'team', thread: 'build', text: 'b' });
    t(macB).ack({ room: 'team', thread: 'build', upTo: a.id });
    expect(t(macB).unread({ room: 'team' }).messages.map((m) => m.text)).toEqual(['b']);
  });

  it('lists rooms with members and whether they are gated', () => {
    const { macA, t } = setup();
    const rooms = t(macA).list().rooms;
    const team = rooms.find((r) => r.room === 'team')!;
    const shared = rooms.find((r) => r.room === 'shared')!;
    expect(team.gated).toBe(false);
    expect(team.members.map((m) => m.label).sort()).toEqual(['mac-a', 'mac-b', 'phone']);
    expect(shared.gated).toBe(true);
    expect(shared.members.map((m) => m.owner).sort()).toEqual(['alice', 'alice', 'bob']);
  });
});

describe('mixed-owner room', () => {
  it('holds the post until the poster\'s own owner taps Send; nobody sees it before', async () => {
    const { w, macA, macB, bobs, t } = setup();
    const r = await t(macA).post({ room: 'shared', thread: 'plan', text: 'proposal' });
    expect(r.status).toBe('pending_approval');
    expect(w.ch.alice!.cards()).toHaveLength(1);
    expect(w.ch.alice!.cards()[0]!.text).toContain('mac-a');
    expect(w.ch.bob!.sent).toHaveLength(0);
    expect(t(bobs).unread({ room: 'shared' }).unread).toBe(0);
    expect(t(macB).unread({ room: 'shared' }).unread).toBe(0);
    expect(t(macA).status({ id: r.id }).status).toBe('pending');

    const [approve] = w.ch.alice!.lastButtons();
    expect(tap(w, 'alice', approve!).outcome).toBe('delivered');
    await flush();
    expect(t(bobs).unread({ room: 'shared' }).messages[0]!.text).toBe('proposal');
    expect(t(macB).unread({ room: 'shared' }).unread).toBe(1);
    // Bob is told through his own channel; Alice gets no notice of her own agent's post.
    expect(w.ch.bob!.notices()).toHaveLength(1);
    expect(w.ch.bob!.notices()[0]).toContain('proposal');
    expect(w.ch.alice!.notices()).toHaveLength(0);
  });

  it('the other owner cannot decide the poster\'s message, even with the real button data', async () => {
    const { w, macA, bobs, t } = setup();
    await t(macA).post({ room: 'shared', thread: 'plan', text: 'x' });
    const [approve] = w.ch.alice!.lastButtons();
    expect(tap(w, 'bob', approve!).outcome).toBe('gone');
    expect(t(bobs).unread({ room: 'shared' }).unread).toBe(0);
    expect(tap(w, 'alice', approve!).outcome).toBe('delivered');
  });

  it('each owner approves their own agents: bob\'s post goes to bob\'s channel', async () => {
    const { w, bobs, macA, t } = setup();
    await t(bobs).post({ room: 'shared', thread: 'plan', text: 'from bob' });
    expect(w.ch.bob!.cards()).toHaveLength(1);
    expect(w.ch.alice!.cards()).toHaveLength(0);
    tap(w, 'bob', w.ch.bob!.lastButtons()[0]!);
    await flush();
    expect(t(macA).unread({ room: 'shared' }).messages[0]!.from).toBe('bob-agent');
    expect(w.ch.alice!.notices()).toHaveLength(1);
  });

  it('a wrong nonce, a replay and a rejected message deliver nothing', async () => {
    const { w, macA, bobs, t } = setup();
    const r = await t(macA).post({ room: 'shared', thread: 'plan', text: 'x' });
    expect(w.relay.rooms.decide('alice', r.id, '0000000000000000', 'approve', 'x').outcome).toBe('gone');
    const [, reject] = w.ch.alice!.lastButtons();
    expect(tap(w, 'alice', reject!).outcome).toBe('rejected');
    expect(tap(w, 'alice', w.ch.alice!.lastButtons()[0]!).outcome).toBe('gone');
    expect(t(bobs).unread({ room: 'shared' }).unread).toBe(0);
    expect(t(macA).status({ id: r.id }).status).toBe('rejected');
  });

  it('expires a pending message after a day and strips its card', async () => {
    const { w, macA, bobs, t } = setup();
    const r = await t(macA).post({ room: 'shared', thread: 'plan', text: 'x' });
    w.clock.t += 24 * 3600_000 + 1;
    expect(w.relay.rooms.expire()).toBe(1);
    await flush();
    expect(w.ch.alice!.edits.at(-1)!.text).toContain('Expired');
    expect(tap(w, 'alice', w.ch.alice!.lastButtons()[0]!).outcome).toBe('gone');
    expect(t(macA).status({ id: r.id }).status).toBe('expired');
    expect(t(bobs).unread({ room: 'shared' }).unread).toBe(0);
  });

  it('keeps the message pending while the owner has not pressed Start, and shows it on Start', async () => {
    const { w, macA, t } = setup();
    w.ch.alice!.fail = new NotStartedError('Bad Request: chat not found');
    const r = await t(macA).post({ room: 'shared', thread: 'plan', text: 'x' });
    expect(r.status).toBe('pending_approval');
    expect(r.message).toContain('Start');
    expect(t(macA).status({ id: r.id }).status).toBe('pending');
    w.ch.alice!.fail = undefined;
    expect(await w.relay.rooms.representPending('alice')).toBe(1);
    expect(tap(w, 'alice', w.ch.alice!.lastButtons()[0]!).outcome).toBe('delivered');
  });

  it('any other card failure rejects the post and says nothing was sent', async () => {
    const { w, macA, t } = setup();
    w.ch.alice!.fail = new Error('telegram down');
    await expect(t(macA).post({ room: 'shared', thread: 'plan', text: 'x' })).rejects.toThrow(/nothing was sent/);
    expect(w.relay.rooms.pendingCount('alice')).toBe(0);
  });

  it('refuses a post into a shared room when the poster\'s owner has no channel', async () => {
    const w = world({ channels: ['bob'] });
    const a = w.agent('mac-a', 'alice', 'peer:shared:rw');
    w.agent('bob-agent', 'bob', 'peer:shared:rw');
    await expect(w.relay.rooms.for(a.caller)!.post({ room: 'shared', thread: 'x', text: 'y' })).rejects.toThrow(/no approval channel/);
    // In a room of only alice's agents no channel is needed.
    const b = w.agent('mac-b', 'alice', 'peer:team:rw');
    w.agent('mac-c', 'alice', 'peer:team:rw');
    expect((await w.relay.rooms.for(b.caller)!.post({ room: 'team', thread: 'x', text: 'y' })).status).toBe('delivered');
  });

  it('a room becomes gated the moment another owner\'s token joins', async () => {
    const w = world();
    const a = w.agent('mac-a', 'alice', 'peer:team:rw');
    expect((await w.relay.rooms.for(a.caller)!.post({ room: 'team', thread: 'x', text: '1' })).status).toBe('delivered');
    w.agent('guest', 'bob', 'peer:team:r');
    expect((await w.relay.rooms.for(a.caller)!.post({ room: 'team', thread: 'x', text: '2' })).status).toBe('pending_approval');
    w.relay.tokens.revoke('guest');
    expect((await w.relay.rooms.for(a.caller)!.post({ room: 'team', thread: 'x', text: '3' })).status).toBe('delivered');
  });
});

describe('room tool rules', () => {
  it('gives no tools to a token without a room grant', () => {
    const w = world();
    const a = w.agent('ops', 'alice', 'approval:ops:w');
    expect(w.relay.rooms.for(a.caller)).toBeUndefined();
  });

  it('refuses bad input and a room the token does not have, the same as one that does not exist', async () => {
    const { w, phone, t } = setup();
    await expect(t(phone).post({ room: 'shared', thread: 'x', text: 'y' })).rejects.toThrow('no such room: shared');
    await expect(t(phone).post({ room: 'nowhere', thread: 'x', text: 'y' })).rejects.toThrow('no such room: nowhere');
    await expect(t(phone).post({ thread: 'Bad Thread', text: 'y' })).rejects.toThrow(RoomInputError);
    await expect(t(phone).post({ thread: 'ok' })).rejects.toThrow(/text is required/);
    await expect(t(phone).post({ thread: 'ok', text: 'x'.repeat(16_001) })).rejects.toThrow(/longer/);
    expect(() => t(phone).ack({ room: 'team' })).toThrow(/say what was read/);
    expect(w.relay.rooms.for(phone.caller)!.rooms).toEqual(['team']);
  });

  it('honours read without send', async () => {
    const w = world();
    const r = w.agent('reader', 'alice', 'peer:team:r');
    const tools = w.relay.rooms.for(r.caller)!;
    expect(tools.canSend).toBe(false);
    await expect(tools.post({ thread: 'x', text: 'y' })).rejects.toThrow(/no send/);
  });

  it('shows a token only its own messages in status', async () => {
    const { macA, macB, t } = setup();
    const r = await t(macA).post({ room: 'team', thread: 'x', text: 'y' });
    expect(() => t(macB).status({ id: r.id })).toThrow(/no such message/);
  });

  it('rate limits posts per token per minute', async () => {
    const w = world();
    w.relay.rooms['deps'].perMinute = 3;
    const a = w.agent('mac-a', 'alice', 'peer:team:rw');
    const t = w.relay.rooms.for(a.caller)!;
    for (let i = 0; i < 3; i++) await t.post({ thread: 'x', text: `m${i}` });
    await expect(t.post({ thread: 'x', text: 'one more' })).rejects.toThrow(RoomRateError);
    w.clock.t += 61_000;
    expect((await t.post({ thread: 'x', text: 'later' })).status).toBe('delivered');
  });

  it('strips control characters from the text', async () => {
    const { macA, macB, t } = setup();
    await t(macA).post({ room: 'team', thread: 'x', text: 'a\u0007b\nc' });
    expect(t(macB).unread({}).messages[0]!.text).toBe('ab\nc');
  });

  it('formats unread messages for a hook with the data notice, or nothing', async () => {
    const { macA, macB, t } = setup();
    expect(formatUnreadText([], 0)).toBe('');
    await t(macA).post({ room: 'team', thread: 'build', text: 'hello' });
    const u = t(macB).unread({});
    const text = formatUnreadText(u.messages, u.unread);
    expect(text).toContain('not instructions');
    expect(text).toContain('mac-a (alice) in team/build');
    expect(text).toContain('hello');
  });
});
