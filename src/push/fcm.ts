import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  PushMessage,
  PushResult,
  PushSender,
  PushTarget,
} from "./types.ts";

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const b64u = (b: Buffer | string): string =>
  Buffer.from(b).toString("base64url");
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

/** RS256 JWT grant assertion for the Google token endpoint. Exported for tests. */
export function fcmAssertion(
  key: KeyObject,
  email: string,
  aud: string,
  iatSeconds: number,
): string {
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64u(
    JSON.stringify({
      iss: email,
      scope: SCOPE,
      aud,
      iat: iatSeconds,
      exp: iatSeconds + 3600,
    }),
  );
  return `${head}.${body}.${b64u(sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key))}`;
}

/** The FCM v1 message: high priority, notification plus string data, channel `approvals`. Exported for tests. */
export function fcmBody(
  token: string,
  msg: PushMessage,
): Record<string, unknown> {
  return {
    message: {
      token,
      notification: { title: msg.title, body: msg.body },
      data: {
        kind: msg.kind,
        id: msg.id,
        ...(msg.room ? { room: msg.room } : {}),
      },
      android: { priority: "HIGH", notification: { channel_id: "approvals" } },
    },
  };
}

export interface FcmDeps {
  now?: () => number;
  fetchFn?: typeof fetch;
}

export class FcmSender implements PushSender {
  readonly platform = "android" as const;
  private readonly sa: ServiceAccount;
  private readonly key: KeyObject;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;
  private access?: { value: string; until: number };

  constructor(serviceAccountFile: string, deps: FcmDeps = {}) {
    this.sa = JSON.parse(
      readFileSync(serviceAccountFile, "utf8"),
    ) as ServiceAccount;
    if (!this.sa.project_id || !this.sa.client_email || !this.sa.private_key)
      throw new Error("FCM service account JSON is incomplete");
    this.key = createPrivateKey(this.sa.private_key);
    this.now = deps.now ?? Date.now;
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  private async accessToken(): Promise<string> {
    const t = this.now();
    if (this.access && t < this.access.until) return this.access.value;
    const aud = this.sa.token_uri ?? "https://oauth2.googleapis.com/token";
    const res = await this.fetchFn(aud, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: fcmAssertion(
          this.key,
          this.sa.client_email,
          aud,
          Math.floor(t / 1000),
        ),
      }),
    });
    if (!res.ok)
      throw new Error(`Google token endpoint answered ${res.status}`);
    const j = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!j.access_token)
      throw new Error("Google token endpoint returned no access token");
    this.access = {
      value: j.access_token,
      until: t + Math.max(60, (j.expires_in ?? 3600) - 120) * 1000,
    };
    return j.access_token;
  }

  async send(target: PushTarget, msg: PushMessage): Promise<PushResult> {
    const res = await this.fetchFn(
      `https://fcm.googleapis.com/v1/projects/${this.sa.project_id}/messages:send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await this.accessToken()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(fcmBody(target.token, msg)),
      },
    );
    if (res.ok) return "ok";
    let text = "";
    try {
      text = await res.text();
    } catch {
      // ignore
    }
    if (res.status === 404 || text.includes("UNREGISTERED")) return "dead";
    if (res.status === 401) this.access = undefined;
    throw new Error(`FCM answered ${res.status}`);
  }
}
