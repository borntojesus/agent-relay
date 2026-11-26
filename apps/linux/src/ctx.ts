import type { AppView } from "./types.ts";

export type Section =
  | "inbox"
  | "rooms"
  | "feed"
  | "team"
  | "audit"
  | "tokens"
  | "settings";

export interface Changes {
  /** feedCursor moved: rooms, threads and the feed may have new messages. */
  feed: boolean;
  pending: boolean;
  /** Any state event (summary, online flag, settings). */
  any: boolean;
}

export interface Ctx {
  app: AppView;
  canSend: boolean;
  nav(
    section: Section,
    opts?: { room?: string; thread?: string; team?: string; flash?: string },
  ): void;
  toast(text: string): void;
  confirm(
    title: string,
    body: string,
    ok: string,
    destructive?: boolean,
  ): Promise<boolean>;
  /** Selected team in the sidebar switcher ('' = everything). */
  team: string;
  setTeam(id: string): void;
  busy: Set<string>;
  /** Re-render the current view from current data. */
  redraw(): void;
}

export interface View {
  title: string;
  el: HTMLElement;
  /** Fill-height views (Rooms) manage their own scrolling. */
  full?: boolean;
  update(ctx: Ctx, ch: Changes): void;
  focus?(opts: {
    room?: string;
    thread?: string;
    team?: string;
    flash?: string;
  }): void;
  destroy?(): void;
}
