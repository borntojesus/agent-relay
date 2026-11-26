// Shapes of docs/console-api.md (0.4.0 with teams), as the UI receives them.

export type MessageStatus = "pending" | "delivered" | "rejected" | "expired";

export interface ConsoleMessage {
  id: number;
  ver: number;
  room: string;
  thread: string;
  from: string;
  owner: string;
  ownerName: string;
  mine: boolean;
  sentAt: string;
  text: string;
  status: MessageStatus;
  gated: boolean;
  decidedAt: string | null;
  decidedBy: string | null;
  read: boolean;
  readBy?: string[];
  seenBy?: string[];
  expiresAt?: string;
}

export interface Approval {
  id: string;
  scope: string;
  project: string;
  action: string;
  tier: string;
  summary: string;
  effect: {
    diff?: string | null;
    recipient?: string | null;
    amount?: string | null;
    details?: string | null;
  };
  requester: string;
  status: string;
  decidedVia: string | null;
  decidedBy: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  ref: string | null;
  caller: string;
}

export interface Summary {
  unread: number;
  unreadOwn: number;
  pendingPosts: number;
  pendingApprovals: number;
  feedCursor: number;
  auditCursor: number;
}

export interface Me {
  owner: { id: string; name: string; tz: string };
  token: { label: string; read: boolean; send: boolean };
  channels: { telegram: boolean; console: boolean };
  version: string;
  teams: Array<{ id: string; name: string; role: string }>;
}

export interface Settings {
  server: string;
  owner: string;
  pollSeconds: number;
  notifications: boolean;
  tray: boolean;
  team: string;
}

export interface AppView {
  signedIn: boolean;
  connecting: boolean;
  me: Me | null;
  server: string;
  settings: Settings;
  signInMessage: string | null;
  sessionOnly: boolean;
  version: string;
  snapshot: {
    online: boolean;
    lastError: string | null;
    lastSync: number | null;
    summary: Summary;
    pending: { posts: ConsoleMessage[]; approvals: Approval[] };
    feed: ConsoleMessage[];
  };
}

export interface Person {
  id: string;
  name: string;
}

export interface Room {
  room: string;
  title: string;
  members: Array<{
    label: string;
    owner: string;
    read: boolean;
    send: boolean;
  }>;
  owners: string[];
  gated: boolean;
  unread: number;
  unreadOwn: number;
  lastAt: string | null;
  threads: number;
  team?: string | null;
  teamName?: string | null;
  people?: Person[];
}

export interface ThreadInfo {
  thread: string;
  messages: number;
  unread: number;
  unreadOwn: number;
  lastAt: string;
  lastSender: string;
}

export interface Team {
  id: string;
  name: string;
  gate: "on" | "off";
  role: "admin" | "member";
  members: Array<{ id: string; name: string; role: "admin" | "member" }>;
  rooms: string[];
  invites?: Array<{ id: number; name: string; note: string | null }>;
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  owner: string | null;
  action: string;
  target: string | null;
  ok: boolean;
  detail: string | null;
}

export interface TokenRow {
  id: number;
  label: string;
  kind: "agent" | "console" | "worker";
  grants: Array<{ channel: string; read: boolean; send: boolean }>;
  rooms: string[];
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  current: boolean;
}

export type OpenTarget =
  | { kind: "post"; id: number; room: string; thread: string }
  | { kind: "approval"; id: string }
  | { kind: "message"; room: string; thread: string };
