/**
 * How the relay reaches one owner: a private chat where their approval cards
 * and notices land. Telegram is the first adapter (src/telegram/owner-bot.ts);
 * a web UI can implement the same interface later.
 *
 * The domain modules build the card text and buttons; the channel only shows
 * them, and routes a press back by owner, so a press can never decide an item
 * that belongs to another owner.
 */
export interface Button {
  text: string;
  callback_data: string;
}

export interface Keyboard {
  inline_keyboard: Button[][];
}

export interface OwnerChannel {
  /** Shows a card (with buttons) or a notice (without); returns its message id. */
  send(text: string, keyboard?: Keyboard): Promise<{ messageId: number }>;
  /** Rewrites a card; without a keyboard its buttons go. */
  edit(messageId: number, text: string, keyboard?: Keyboard): Promise<void>;
  /** Where the owner presses Start, for telling them when a card cannot be delivered. */
  readonly link?: string;
}

export type ChannelFor = (owner: string) => OwnerChannel | undefined;

/**
 * Telegram will not let a bot write first: until the owner opens their bot
 * and presses Start, every card fails with "chat not found".
 */
export class NotStartedError extends Error {
  constructor(description: string) {
    super(`the owner has not started their approval bot (${description})`);
    this.name = 'NotStartedError';
  }
}

/**
 * The owner console as an approval channel: an owner with an active console
 * token can hold posts and big approvals even without a Telegram bot. The
 * items live in the database, where the console reads them, so there is no
 * card to show: `send` answers message id 0 (no card) and `edit` does nothing.
 */
export class ConsoleChannel implements OwnerChannel {
  async send(): Promise<{ messageId: number }> {
    return { messageId: 0 };
  }

  async edit(): Promise<void> {}
}
