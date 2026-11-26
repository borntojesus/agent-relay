import type { DatabaseSync } from "node:sqlite";

export type Platform = "ios" | "android";
export type PushEnvironment = "sandbox" | "production";

export interface Device {
  token: string;
  owner: string;
  platform: Platform;
  environment: PushEnvironment;
  app: string;
  createdAt: string;
  lastSeenAt: string;
}

interface Row {
  token: string;
  owner: string;
  platform: Platform;
  environment: PushEnvironment;
  app: string;
  created_at: string;
  last_seen_at: string;
}

const toDevice = (r: Row): Device => ({
  token: r.token,
  owner: r.owner,
  platform: r.platform,
  environment: r.environment,
  app: r.app,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
});

/** Push tokens of an owner's devices. A token belongs to one owner at a time. */
export class DeviceStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  /** Registers or refreshes a token; a token seen under another owner moves to this one. */
  upsert(d: {
    token: string;
    owner: string;
    platform: Platform;
    environment: PushEnvironment;
    app: string;
  }): void {
    const at = new Date(this.now()).toISOString();
    this.db
      .prepare(
        `INSERT INTO push_devices (token, owner, platform, environment, app, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET owner = excluded.owner, platform = excluded.platform,
           environment = excluded.environment, app = excluded.app, last_seen_at = excluded.last_seen_at`,
      )
      .run(d.token, d.owner, d.platform, d.environment, d.app, at, at);
  }

  /** Deletes the token when it belongs to this owner; true when something was removed. */
  delete(owner: string, token: string): boolean {
    return (
      Number(
        this.db
          .prepare(`DELETE FROM push_devices WHERE token = ? AND owner = ?`)
          .run(token, owner).changes,
      ) > 0
    );
  }

  /** Removes a dead token whoever owns it (the push service said it is gone). */
  remove(token: string): void {
    this.db.prepare(`DELETE FROM push_devices WHERE token = ?`).run(token);
  }

  touch(token: string): void {
    this.db
      .prepare(`UPDATE push_devices SET last_seen_at = ? WHERE token = ?`)
      .run(new Date(this.now()).toISOString(), token);
  }

  list(owner: string): Device[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM push_devices WHERE owner = ? ORDER BY created_at, rowid`,
        )
        .all(owner) as unknown as Row[]
    ).map(toDevice);
  }
}
