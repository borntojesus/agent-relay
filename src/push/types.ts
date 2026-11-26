import type { Platform, PushEnvironment } from "./devices.ts";

export type PushKind = "post" | "approval" | "task" | "tool";

/** What a push carries: ids and a neutral text, never text written by an agent. */
export interface PushMessage {
  kind: PushKind;
  id: string;
  room?: string;
  title: string;
  body: string;
  /** Actionable kinds get the APPROVAL category (iOS) so the lock screen shows the buttons. */
  actionable: boolean;
}

export interface PushTarget {
  token: string;
  environment: PushEnvironment;
  app: string;
}

/** `dead` means the push service says the token is gone and must be deleted. Other failures throw. */
export type PushResult = "ok" | "dead";

export interface PushSender {
  readonly platform: Platform;
  send(target: PushTarget, msg: PushMessage): Promise<PushResult>;
}

/** The item an owner has to look at; the dispatcher turns it into a neutral message. */
export interface PendingItem {
  kind: PushKind;
  id: string | number;
  room?: string;
}

export type OnPending = (owner: string, item: PendingItem) => void;
