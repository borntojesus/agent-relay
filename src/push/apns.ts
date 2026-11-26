import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, type ClientHttp2Session } from "node:http2";
import type {
  PushMessage,
  PushResult,
  PushSender,
  PushTarget,
} from "./types.ts";

export interface ApnsConfig {
  keyFile: string;
  keyId: string;
  teamId: string;
  topic: string;
}

const b64u = (b: Buffer | string): string =>
  Buffer.from(b).toString("base64url");

/** ES256 provider token for APNs: header {alg, kid}, claims {iss, iat}. Exported for tests. */
export function apnsJwt(
  key: KeyObject,
  keyId: string,
  teamId: string,
  iatSeconds: number,
): string {
  const head = b64u(JSON.stringify({ alg: "ES256", kid: keyId }));
  const body = b64u(JSON.stringify({ iss: teamId, iat: iatSeconds }));
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${head}.${body}.${b64u(sig)}`;
}

/** What goes to APNs as the request body. Exported for tests. */
export function apnsBody(msg: PushMessage): Record<string, unknown> {
  return {
    aps: {
      alert: { title: msg.title, body: msg.body },
      sound: "default",
      ...(msg.actionable ? { category: "APPROVAL" } : {}),
    },
    kind: msg.kind,
    id: msg.id,
    ...(msg.room ? { room: msg.room } : {}),
  };
}

const TOKEN_MS = 50 * 60_000;

export interface ApnsDeps {
  now?: () => number;
  /** Replaces the HTTP/2 round trip (tests): returns status and the `reason` of the reply. */
  request?: (
    host: string,
    headers: Record<string, string>,
    body: string,
  ) => Promise<{ status: number; reason?: string }>;
}

export class ApnsSender implements PushSender {
  readonly platform = "ios" as const;
  private readonly cfg: ApnsConfig;
  private readonly key: KeyObject;
  private readonly now: () => number;
  private readonly doRequest: NonNullable<ApnsDeps["request"]>;
  private jwt?: { value: string; at: number };

  constructor(cfg: ApnsConfig, deps: ApnsDeps = {}) {
    this.cfg = cfg;
    this.key = createPrivateKey(readFileSync(cfg.keyFile));
    this.now = deps.now ?? Date.now;
    this.doRequest = deps.request ?? http2Request;
  }

  private token(): string {
    const t = this.now();
    if (!this.jwt || t - this.jwt.at > TOKEN_MS) {
      this.jwt = {
        value: apnsJwt(
          this.key,
          this.cfg.keyId,
          this.cfg.teamId,
          Math.floor(t / 1000),
        ),
        at: t,
      };
    }
    return this.jwt.value;
  }

  async send(target: PushTarget, msg: PushMessage): Promise<PushResult> {
    const host =
      target.environment === "production"
        ? "api.push.apple.com"
        : "api.sandbox.push.apple.com";
    const headers = {
      ":method": "POST",
      ":path": `/3/device/${target.token}`,
      authorization: `bearer ${this.token()}`,
      "apns-topic": this.cfg.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    };
    const r = await this.doRequest(
      host,
      headers,
      JSON.stringify(apnsBody(msg)),
    );
    if (r.status === 200) return "ok";
    if (
      r.status === 410 ||
      r.reason === "BadDeviceToken" ||
      r.reason === "Unregistered"
    )
      return "dead";
    if (r.status === 403) this.jwt = undefined;
    throw new Error(
      `APNs answered ${r.status}${r.reason ? ` ${r.reason}` : ""}`,
    );
  }
}

function http2Request(
  host: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; reason?: string }> {
  return new Promise((resolve, reject) => {
    let session: ClientHttp2Session;
    try {
      session = connect(`https://${host}`);
    } catch (err) {
      reject(err);
      return;
    }
    const done = (fn: () => void) => {
      session.close();
      fn();
    };
    const timer = setTimeout(
      () => done(() => reject(new Error("APNs timed out"))),
      15_000,
    );
    timer.unref();
    session.on("error", (err) => {
      clearTimeout(timer);
      done(() => reject(err));
    });
    const req = session.request(headers);
    let status = 0;
    const chunks: Buffer[] = [];
    req.on("response", (h) => {
      status = Number(h[":status"] ?? 0);
    });
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("error", (err) => {
      clearTimeout(timer);
      done(() => reject(err));
    });
    req.on("end", () => {
      clearTimeout(timer);
      let reason: string | undefined;
      try {
        reason = (
          JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            reason?: string;
          }
        ).reason;
      } catch {
        // empty body on success
      }
      done(() => resolve({ status, ...(reason ? { reason } : {}) }));
    });
    req.end(body);
  });
}
