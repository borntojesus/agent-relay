import { describe, expect, it } from 'vitest';
import { OwnerBot, retryDelayMs } from '../src/telegram/owner-bot.ts';
import { flush, world } from './helpers.ts';

/** A Telegram API stand-in that records calls. */
function fakeTelegram() {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let next = 500;
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').at(-1)!;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: method === 'sendMessage' ? { message_id: next++ } : true }), { status: 200 });
  };
  return { calls, fetchFn: fetchFn as typeof fetch };
}

/** Alice's agents in a mixed room, Alice's bot wired to a fake Telegram. */
function setup() {
  const w = world({ channels: ['bob'] });
  const tg = fakeTelegram();
  const bot = new OwnerBot({ owner: 'alice', botToken: 'test', userId: '111', rooms: w.relay.rooms, approvals: w.relay.approvals, fetchFn: tg.fetchFn });
  w.relay.channels.set('alice', bot);
  const mac = w.agent('mac-a', 'alice', 'peer:shared:rw', 'approval:ops:w');
  const bobs = w.agent('bob-agent', 'bob', 'peer:shared:rw');
  return { w, tg, bot, mac, bobs };
}

const press = (data: string, from = 111, chat = 111) => ({
  update_id: 1,
  callback_query: { id: 'cb1', data, from: { id: from }, message: { message_id: 500, chat: { id: chat }, text: 'card' } },
});
const buttonsOf = (tg: ReturnType<typeof fakeTelegram>) =>
  ((tg.calls.filter((c) => c.method === 'sendMessage').at(-1)!.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> })
    .inline_keyboard.flat().map((b) => b.callback_data));

describe('owner bot', () => {
  it('sends the room card to its own user and delivers on that user\'s press', async () => {
    const { w, tg, bot, mac, bobs } = setup();
    await w.relay.rooms.for(mac.caller)!.post({ room: 'shared', thread: 'plan', text: 'hi' });
    const card = tg.calls.find((c) => c.method === 'sendMessage')!;
    expect(card.body.chat_id).toBe('111');
    const [approve] = buttonsOf(tg);
    await bot.handleUpdate(press(approve!));
    await flush();
    expect(tg.calls.find((c) => c.method === 'answerCallbackQuery')!.body.text).toBe('✅ Sent');
    expect(tg.calls.some((c) => c.method === 'editMessageText')).toBe(true);
    expect(w.relay.rooms.for(bobs.caller)!.unread({}).unread).toBe(1);
  });

  it('ignores presses and /start from anyone but its user', async () => {
    const { w, tg, bot, mac, bobs } = setup();
    await w.relay.rooms.for(mac.caller)!.post({ room: 'shared', thread: 'plan', text: 'hi' });
    const [approve] = buttonsOf(tg);
    await bot.handleUpdate(press(approve!, 222, 111));
    await bot.handleUpdate(press(approve!, 222, 222));
    expect(tg.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.body.text)).toEqual(['No access', 'No access']);
    const before = tg.calls.length;
    await bot.handleUpdate({ update_id: 2, message: { text: '/start', chat: { id: 222 }, from: { id: 222 } } });
    expect(tg.calls.length).toBe(before);
    expect(w.relay.rooms.for(bobs.caller)!.unread({}).unread).toBe(0);
  });

  it('routes approval cards to the approvals of its own owner', async () => {
    const { w, tg, bot, mac } = setup();
    const v = await w.relay.approvals.create(mac.caller, {
      project: 'web-app', action: 'deploy', summary: 'ship', requester: 'mac-a', clientProject: false, effect: {}, ttlMinutes: 15, card: false,
    });
    const [ok] = buttonsOf(tg);
    await bot.handleUpdate(press(ok!));
    expect(w.relay.approvals.status(mac.caller.key, v.id)!.status).toBe('approved');
    expect(tg.calls.filter((c) => c.method === 'answerCallbackQuery').at(-1)!.body.text).toBe('✅ Approved');
  });

  it('a bot of another owner cannot press this owner\'s cards', async () => {
    const { w, tg, mac } = setup();
    const other = fakeTelegram();
    const bobBot = new OwnerBot({ owner: 'bob', botToken: 't2', userId: '222', rooms: w.relay.rooms, approvals: w.relay.approvals, fetchFn: other.fetchFn });
    await w.relay.rooms.for(mac.caller)!.post({ room: 'shared', thread: 'plan', text: 'hi' });
    const [approve] = buttonsOf(tg);
    await bobBot.handleUpdate(press(approve!, 222, 222));
    expect(other.calls.find((c) => c.method === 'answerCallbackQuery')!.body.text).toBe('Already decided or expired');
    expect(w.relay.rooms.pendingCount('alice')).toBe(1);
  });

  it('/start greets and shows cards that waited for it', async () => {
    const w = world({ channels: ['bob'] });
    let started = false;
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      const method = String(url).split('/').at(-1)!;
      calls.push(method);
      if (!started && method === 'sendMessage') return new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 400 });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 });
    }) as typeof fetch;
    const bot = new OwnerBot({ owner: 'alice', botToken: 't', userId: '111', rooms: w.relay.rooms, approvals: w.relay.approvals, fetchFn });
    w.relay.channels.set('alice', bot);
    const mac = w.agent('mac-a', 'alice', 'peer:shared:rw');
    w.agent('bob-agent', 'bob', 'peer:shared:rw');
    const r = await w.relay.rooms.for(mac.caller)!.post({ room: 'shared', thread: 'plan', text: 'hi' });
    expect(r.status).toBe('pending_approval');
    started = true;
    calls.length = 0;
    await bot.handleUpdate({ update_id: 2, message: { text: '/start', chat: { id: 111 }, from: { id: 111 } } });
    expect(calls.filter((m) => m === 'sendMessage')).toHaveLength(2);
  });

  it('backs off with jitter up to five minutes', () => {
    expect(retryDelayMs(0, () => 0.999)).toBe(1000);
    expect(retryDelayMs(3, () => 0)).toBe(1000);
    expect(retryDelayMs(3, () => 0.999)).toBeLessThanOrEqual(8000);
    expect(retryDelayMs(30, () => 0.999)).toBeLessThanOrEqual(300_000);
    expect(retryDelayMs(30, () => 0.999)).toBeGreaterThan(250_000);
  });
});
