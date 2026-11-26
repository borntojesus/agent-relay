import { NotStartedError, type Keyboard, type OwnerChannel } from '../approvals/channel.ts';
import { APPROVAL_CALLBACK, type ActionApprovals } from '../approvals/actions.ts';
import { MESSAGE_CALLBACK, type RoomService } from '../rooms/service.ts';

type FetchFn = typeof fetch;

interface Update {
  update_id: number;
  message?: { text?: string; chat: { id: number }; from?: { id: number } };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number };
    message?: { message_id: number; chat: { id: number }; text?: string };
  };
}

export interface OwnerBotDeps {
  /** The owner whose cards this bot shows and whose taps it carries. */
  owner: string;
  /** This owner's own bot; never shared between owners. */
  botToken: string;
  /** The one Telegram user this bot serves. In a private chat, chat id = user id. */
  userId: string;
  rooms: Pick<RoomService, 'decide' | 'representPending' | 'pendingCount'>;
  approvals: Pick<ActionApprovals, 'tap'>;
  fetchFn?: FetchFn;
  log?: (msg: string) => void;
  random?: () => number;
}

/** Full jitter backoff: 1 s doubling to 5 min. */
export function retryDelayMs(failures: number, random: () => number = Math.random): number {
  const cap = Math.min(300_000, 1000 * 2 ** Math.min(failures, 20));
  return Math.max(1000, Math.floor(random() * cap));
}

/**
 * One owner's approval channel on Telegram: a bot of their own, bound to
 * their user id. It shows cards for their agents' gated room posts and action
 * approvals, and notices of messages their agents received from other owners.
 *
 * A tap reaches only this owner's items: room decisions go through
 * `rooms.decide(owner, ...)` and action taps through
 * `approvals.tap(owner, ...)`, both of which check the owner in the database,
 * so a card forwarded to another owner's bot changes nothing. A press or
 * message from anyone but the bound user is ignored.
 */
export class OwnerBot implements OwnerChannel {
  private readonly deps: OwnerBotDeps;
  private offset = 0;
  private abort?: AbortController;
  private running = false;
  private wake?: () => void;
  private generation = 0;
  link?: string;

  constructor(deps: OwnerBotDeps) {
    this.deps = deps;
  }

  private call(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    return (this.deps.fetchFn ?? fetch)(`https://api.telegram.org/bot${this.deps.botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    });
  }

  private async refused(res: Response, method: string): Promise<never> {
    const body = (await res.json().catch(() => ({}))) as { description?: string };
    const description = body.description ?? `status ${res.status}`;
    if (/chat not found|bot was blocked|user is deactivated/i.test(description)) throw new NotStartedError(description);
    throw new Error(`telegram ${method} failed: ${description}`);
  }

  async send(text: string, keyboard?: Keyboard): Promise<{ messageId: number }> {
    const res = await this.call('sendMessage', {
      chat_id: this.deps.userId,
      text,
      disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
    if (!res.ok) await this.refused(res, 'sendMessage');
    const body = (await res.json().catch(() => ({}))) as { result?: { message_id?: number } };
    return { messageId: body.result?.message_id ?? 0 };
  }

  async edit(messageId: number, text: string, keyboard?: Keyboard): Promise<void> {
    const res = await this.call('editMessageText', {
      chat_id: this.deps.userId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
    if (!res.ok) await this.refused(res, 'editMessageText');
  }

  private isOwner(chatId: unknown, fromId: unknown): boolean {
    return String(chatId) === this.deps.userId && String(fromId) === this.deps.userId;
  }

  /** Applies one update. Exposed so the logic is testable offline. */
  async handleUpdate(update: Update): Promise<void> {
    const msg = update.message;
    if (msg) {
      if (!this.isOwner(msg.chat.id, msg.from?.id)) return;
      if ((msg.text ?? '').trim().startsWith('/start')) {
        const waiting = this.deps.rooms.pendingCount(this.deps.owner);
        await this.send(
          'Connected. Cards for what your agents want to post in shared rooms, action approvals, and notices of messages from other people\'s agents arrive here. This bot does nothing else.' +
            (waiting ? `\n\n${waiting} card(s) already waiting, below.` : ''),
        ).catch(() => undefined);
        if (waiting) await this.deps.rooms.representPending(this.deps.owner);
      }
      return;
    }
    const cb = update.callback_query;
    if (!cb) return;
    const answer = (text: string) => this.call('answerCallbackQuery', { callback_query_id: cb.id, text }).catch(() => undefined);
    if (!this.isOwner(cb.message?.chat.id, cb.from?.id)) {
      await answer('No access');
      return;
    }
    const actor = String(cb.from?.id ?? '');
    const data = cb.data ?? '';
    const pm = MESSAGE_CALLBACK.exec(data);
    if (pm) {
      const { outcome } = this.deps.rooms.decide(this.deps.owner, Number(pm[1]), pm[2]!, pm[3] === 'a' ? 'approve' : 'reject', `owner:${actor}`);
      const label = outcome === 'delivered' ? '✅ Sent' : outcome === 'rejected' ? '✖️ Rejected' : 'Already decided or expired';
      await answer(label);
      if (cb.message) await this.edit(cb.message.message_id, `${cb.message.text ?? ''}\n\n${label}`).catch(() => undefined);
      return;
    }
    const apv = APPROVAL_CALLBACK.exec(data);
    if (apv) {
      const tap = await this.deps.approvals.tap(this.deps.owner, apv[1]!, apv[2]!, apv[3] as 'a' | 'r' | 'd', actor);
      if (tap.kind === 'unknown') {
        await answer('Unknown card');
        return;
      }
      await answer(tap.kind === 'decided' || tap.kind === 'already' ? tap.said : tap.kind === 'expired' ? 'Expired' : 'Details');
      if (cb.message && 'card' in tap && tap.card) {
        await this.edit(cb.message.message_id, tap.card, tap.kind === 'details' ? tap.keyboard : undefined).catch(() => undefined);
      }
      return;
    }
    await answer('Unknown action');
  }

  async pollOnce(timeoutSeconds = 25): Promise<number> {
    this.abort = new AbortController();
    const res = await this.call('getUpdates', { offset: this.offset, timeout: timeoutSeconds, allowed_updates: ['callback_query', 'message'] }, this.abort.signal);
    if (!res.ok) throw new Error(`telegram getUpdates failed with status ${res.status}`);
    const body = (await res.json()) as { result?: Update[] };
    const updates = body.result ?? [];
    for (const update of updates) {
      this.offset = update.update_id + 1;
      try {
        await this.handleUpdate(update);
      } catch (err) {
        this.deps.log?.(`[bot:${this.deps.owner}] update ${update.update_id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return updates.length;
  }

  start(): void {
    if (this.running) return;
    void this.call('getMe', {})
      .then((r) => r.json() as Promise<{ result?: { username?: string } }>)
      .then((b) => {
        if (b.result?.username) this.link = `https://t.me/${b.result.username}`;
      })
      .catch(() => undefined);
    this.running = true;
    const generation = ++this.generation;
    const current = () => this.running && this.generation === generation;
    void (async () => {
      let failures = 0;
      while (current()) {
        try {
          await this.pollOnce();
          failures = 0;
        } catch (err) {
          if (!current()) break;
          failures += 1;
          const delay = retryDelayMs(failures, this.deps.random);
          if (failures === 1 || failures % 10 === 0) {
            this.deps.log?.(`[bot:${this.deps.owner}] ${err instanceof Error ? err.message : String(err)} (${failures} in a row); retrying in ${Math.round(delay / 1000)}s`);
          }
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delay);
            this.wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
        }
      }
    })();
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.abort?.abort();
    this.wake?.();
  }
}
