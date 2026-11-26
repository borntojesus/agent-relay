import type { AddressInfo } from "node:net";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpServer } from "../src/http/server.ts";
import { parseApprovalRequest } from "../src/approvals/actions.ts";
import { ApnsSender, apnsBody, apnsJwt } from "../src/push/apns.ts";
import { FcmSender } from "../src/push/fcm.ts";
import type {
  PushMessage,
  PushResult,
  PushSender,
  PushTarget,
} from "../src/push/types.ts";
import { addMachine, flush, world } from "./helpers.ts";

class FakeSender implements PushSender {
  sent: Array<{ target: PushTarget; msg: PushMessage }> = [];
  result: PushResult = "ok";
  fail = false;
  readonly platform: "ios" | "android";
  constructor(platform: "ios" | "android") {
    this.platform = platform;
  }
  async send(target: PushTarget, msg: PushMessage): Promise<PushResult> {
    this.sent.push({ target, msg });
    if (this.fail) throw new Error("boom");
    return this.result;
  }
}

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  while (servers.length) servers.pop()!.close();
});

async function up() {
  const ios = new FakeSender("ios");
  const android = new FakeSender("android");
  const w = world({ pushSenders: [ios, android] });
  const server = createHttpServer(w.relay);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (
    method: string,
    path: string,
    token: string,
    json?: unknown,
  ) => {
    const r = await fetch(base + path, {
      method,
      body: json === undefined ? undefined : JSON.stringify(json),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    const text = await r.text();
    return {
      status: r.status,
      body: (text ? JSON.parse(text) : undefined) as any,
    };
  };
  const rw = w.agent("alice-console", "alice", "owner:alice:rw");
  const ro = w.agent("alice-ro", "alice", "owner:alice:r");
  const bob = w.agent("bob-console", "bob", "owner:bob:rw");
  return { w, ios, android, call, rw, ro, bob };
}

const dev = (token: string, over: Record<string, unknown> = {}) => ({
  token,
  platform: "ios",
  environment: "sandbox",
  app: "org.example.relay",
  ...over,
});

describe("device registry routes", () => {
  it("registers, lists without the token, upserts and deletes", async () => {
    const { call, rw, w } = await up();
    expect(
      (await call("POST", "/owner/devices", rw.token, dev("tok-aaaaaaaa")))
        .status,
    ).toBe(204);
    w.clock.t += 1000;
    expect(
      (
        await call(
          "POST",
          "/owner/devices",
          rw.token,
          dev("tok-aaaaaaaa", { environment: "production" }),
        )
      ).status,
    ).toBe(204);
    const list = await call("GET", "/owner/devices", rw.token);
    expect(list.status).toBe(200);
    expect(list.body.devices).toHaveLength(1);
    expect(list.body.devices[0]).toEqual({
      platform: "ios",
      environment: "production",
      app: "org.example.relay",
      createdAt: "2026-11-23T10:00:00.000Z",
      lastSeenAt: "2026-11-23T10:00:01.000Z",
    });
    expect(JSON.stringify(list.body)).not.toContain("tok-aaaaaaaa");
    expect(
      (await call("DELETE", "/owner/devices/tok-aaaaaaaa", rw.token)).status,
    ).toBe(204);
    expect(
      (await call("GET", "/owner/devices", rw.token)).body.devices,
    ).toEqual([]);
  });

  it("validates input and needs the write right", async () => {
    const { call, rw, ro } = await up();
    for (const bad of [
      {},
      dev("x"),
      dev("tok-aaaaaaaa", { platform: "web" }),
      dev("tok-aaaaaaaa", { environment: "dev" }),
      dev("tok-aaaaaaaa", { app: "" }),
    ]) {
      expect((await call("POST", "/owner/devices", rw.token, bad)).status).toBe(
        400,
      );
    }
    expect(
      (await call("POST", "/owner/devices", ro.token, dev("tok-aaaaaaaa")))
        .status,
    ).toBe(403);
    expect(
      (await call("DELETE", "/owner/devices/tok-aaaaaaaa", ro.token)).status,
    ).toBe(403);
    expect((await call("GET", "/owner/devices", ro.token)).status).toBe(200);
  });

  it("an owner cannot delete or see another owner's device", async () => {
    const { call, rw, bob } = await up();
    await call("POST", "/owner/devices", rw.token, dev("tok-aaaaaaaa"));
    expect(
      (await call("GET", "/owner/devices", bob.token)).body.devices,
    ).toEqual([]);
    await call("DELETE", "/owner/devices/tok-aaaaaaaa", bob.token);
    expect(
      (await call("GET", "/owner/devices", rw.token)).body.devices,
    ).toHaveLength(1);
  });
});

describe("push triggers", () => {
  async function withDevices() {
    const u = await up();
    u.w.relay.devices.upsert({
      token: "alice-ios-token",
      owner: "alice",
      platform: "ios",
      environment: "sandbox",
      app: "a",
    });
    u.w.relay.devices.upsert({
      token: "alice-and-token",
      owner: "alice",
      platform: "android",
      environment: "production",
      app: "a",
    });
    u.w.relay.devices.upsert({
      token: "bob-ios-token",
      owner: "bob",
      platform: "ios",
      environment: "sandbox",
      app: "a",
    });
    return u;
  }

  it("a held post pushes to the poster's owner only, with a neutral text", async () => {
    const { w, ios, android } = await withDevices();
    const mac = w.agent("mac-a", "alice", "peer:shared:rw");
    w.agent("bob-agent", "bob", "peer:shared:rw");
    await w.relay.rooms
      .for(mac.caller)!
      .post({ room: "shared", thread: "t", text: "SECRET agent words" });
    await flush();
    expect(ios.sent).toHaveLength(1);
    expect(android.sent).toHaveLength(1);
    expect(ios.sent[0]!.target.token).toBe("alice-ios-token");
    expect(ios.sent[0]!.msg).toMatchObject({
      kind: "post",
      room: "shared",
      title: "Post waiting",
      body: "Post waiting for your tap",
    });
    expect(JSON.stringify(ios.sent)).not.toContain("SECRET");
  });

  it("a pending action approval pushes to its owner", async () => {
    const { w, ios } = await withDevices();
    const a = w.agent("mac-a", "alice", "approval:ops:w");
    const v = await w.relay.approvals.create(
      a.caller,
      parseApprovalRequest({
        project: "web-app",
        action: "deploy",
        summary: "SECRET summary",
        requester: "mac-a",
      }),
    );
    await flush();
    expect(ios.sent).toHaveLength(1);
    expect(ios.sent[0]!.msg).toMatchObject({
      kind: "approval",
      id: v.id,
      actionable: true,
    });
    expect(JSON.stringify(ios.sent)).not.toContain("SECRET");
  });

  it("an auto-approved read does not push", async () => {
    const { w, ios } = await withDevices();
    const a = w.agent("mac-a", "alice", "approval:ops:w");
    await w.relay.approvals.create(
      a.caller,
      parseApprovalRequest({
        project: "web-app",
        action: "status",
        summary: "s",
        requester: "mac-a",
      }),
    );
    await flush();
    expect(ios.sent).toHaveLength(0);
  });

  it("a task in awaiting_tap and a pending tool approval push to the task's owner", async () => {
    const { w, ios, android } = await withDevices();
    addMachine(w, "mini", "alice", { requireTap: true });
    const t = w.relay.tasks.create("alice", "alice-console", {
      machine: "mini",
      folder: "/work/app",
      prompt: "SECRET prompt",
    });
    await flush();
    expect(ios.sent).toHaveLength(1);
    expect(ios.sent[0]!.msg).toMatchObject({
      kind: "task",
      id: t.id,
      actionable: false,
    });
    w.relay.tasks.updateMachine(
      "alice",
      "mini",
      { policy: { requireTap: false } },
      "c",
    );
    const t2 = w.relay.tasks.create("alice", "alice-console", {
      machine: "mini",
      folder: "/work/app",
      prompt: "p",
    });
    expect(ios.sent).toHaveLength(1); // queued: no push
    w.relay.tasks.claim("mini", "worker:mini-worker");
    w.relay.tasks.workerStatus(
      "mini",
      t2.id,
      { status: "running" },
      "worker:mini-worker",
    );
    const apv = w.relay.tasks.requestApproval(
      "mini",
      t2.id,
      { tool: "Bash", summary: "SECRET cmd", category: "push" },
      "worker:mini-worker",
    );
    await flush();
    expect(ios.sent).toHaveLength(2);
    expect(ios.sent[1]!.msg).toMatchObject({
      kind: "tool",
      id: apv.id,
      actionable: true,
    });
    expect(android.sent).toHaveLength(2);
    expect(JSON.stringify([ios.sent, android.sent])).not.toContain("SECRET");
  });
});

describe("failure handling", () => {
  it("a dead token is deleted; a failing sender is logged without the token and never throws", async () => {
    const { w, ios, android } = await up();
    w.relay.devices.upsert({
      token: "dead-token-ios",
      owner: "alice",
      platform: "ios",
      environment: "sandbox",
      app: "a",
    });
    w.relay.devices.upsert({
      token: "flaky-token-and",
      owner: "alice",
      platform: "android",
      environment: "sandbox",
      app: "a",
    });
    ios.result = "dead";
    android.fail = true;
    const a = w.agent("mac-a", "alice", "approval:ops:w");
    await w.relay.approvals.create(
      a.caller,
      parseApprovalRequest({
        project: "web-app",
        action: "deploy",
        summary: "s",
        requester: "mac-a",
      }),
    );
    await flush();
    expect(w.relay.devices.list("alice").map((d) => d.token)).toEqual([
      "flaky-token-and",
    ]);
    const logs = w.logs.join("\n");
    expect(logs).toContain("android send for alice failed");
    expect(logs).not.toContain("token-");
  });
});

describe("APNs and FCM construction", () => {
  const msg: PushMessage = {
    kind: "approval",
    id: "ab",
    title: "Approval waiting",
    body: "b",
    actionable: true,
  };

  it("signs the APNs provider token with ES256 and sends the right headers", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    const dir = mkdtempSync(join(tmpdir(), "apns-"));
    try {
      const keyFile = join(dir, "AuthKey.p8");
      writeFileSync(
        keyFile,
        privateKey.export({ type: "pkcs8", format: "pem" }),
      );
      const calls: Array<{
        host: string;
        headers: Record<string, string>;
        body: string;
      }> = [];
      const clock = { t: 1_800_000_000_000 };
      const s = new ApnsSender(
        {
          keyFile,
          keyId: "KEY1234567",
          teamId: "TEAM123456",
          topic: "org.example.relay",
        },
        {
          now: () => clock.t,
          request: async (host, headers, body) => {
            calls.push({ host, headers, body });
            return { status: 200 };
          },
        },
      );
      expect(
        await s.send(
          { token: "devtok", environment: "sandbox", app: "a" },
          msg,
        ),
      ).toBe("ok");
      clock.t += 49 * 60_000;
      await s.send(
        { token: "devtok", environment: "production", app: "a" },
        msg,
      );
      clock.t += 2 * 60_000;
      await s.send(
        { token: "devtok", environment: "production", app: "a" },
        msg,
      );
      expect(calls[0]!.host).toBe("api.sandbox.push.apple.com");
      expect(calls[1]!.host).toBe("api.push.apple.com");
      const h = calls[0]!.headers;
      expect(h[":path"]).toBe("/3/device/devtok");
      expect(h["apns-topic"]).toBe("org.example.relay");
      expect(h["apns-push-type"]).toBe("alert");
      expect(h["apns-priority"]).toBe("10");
      // cached for ~50 minutes, then renewed
      expect(calls[1]!.headers.authorization).toBe(h.authorization);
      expect(calls[2]!.headers.authorization).not.toBe(h.authorization);
      const jwt = h.authorization!.replace("bearer ", "");
      const [head, body, sig] = jwt.split(".");
      expect(JSON.parse(Buffer.from(head!, "base64url").toString())).toEqual({
        alg: "ES256",
        kid: "KEY1234567",
      });
      expect(JSON.parse(Buffer.from(body!, "base64url").toString())).toEqual({
        iss: "TEAM123456",
        iat: 1_800_000_000,
      });
      expect(
        verify(
          "sha256",
          Buffer.from(`${head}.${body}`),
          { key: publicKey, dsaEncoding: "ieee-p1363" },
          Buffer.from(sig!, "base64url"),
        ),
      ).toBe(true);
      expect(apnsJwt(privateKey, "K", "T", 1).split(".")).toHaveLength(3);
      expect(JSON.parse(calls[0]!.body).aps.category).toBe("APPROVAL");
      expect(
        apnsBody({ ...msg, kind: "task", actionable: false }).aps,
      ).not.toHaveProperty("category");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps APNs 410 and BadDeviceToken to dead, other errors throw", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const dir = mkdtempSync(join(tmpdir(), "apns-"));
    try {
      const keyFile = join(dir, "k.p8");
      writeFileSync(
        keyFile,
        privateKey.export({ type: "pkcs8", format: "pem" }),
      );
      let reply: { status: number; reason?: string } = { status: 410 };
      const s = new ApnsSender(
        { keyFile, keyId: "K", teamId: "T", topic: "t" },
        { request: async () => reply },
      );
      const target = { token: "x", environment: "sandbox" as const, app: "a" };
      expect(await s.send(target, msg)).toBe("dead");
      reply = { status: 400, reason: "BadDeviceToken" };
      expect(await s.send(target, msg)).toBe("dead");
      reply = { status: 500 };
      await expect(s.send(target, msg)).rejects.toThrow("APNs answered 500");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FCM exchanges a service account JWT once, then sends high priority on channel approvals; UNREGISTERED is dead", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const dir = mkdtempSync(join(tmpdir(), "fcm-"));
    try {
      const file = join(dir, "sa.json");
      writeFileSync(
        file,
        JSON.stringify({
          project_id: "proj-1",
          client_email: "sa@proj-1.iam.example",
          private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
        }),
      );
      const reqs: Array<{ url: string; init: RequestInit }> = [];
      let sendStatus = 200;
      const fetchFn = (async (url: string, init: RequestInit) => {
        reqs.push({ url, init });
        if (url.includes("oauth2"))
          return new Response(
            JSON.stringify({ access_token: "at-1", expires_in: 3600 }),
            { status: 200 },
          );
        return sendStatus === 200
          ? new Response("{}", { status: 200 })
          : new Response(
              JSON.stringify({
                error: { details: [{ errorCode: "UNREGISTERED" }] },
              }),
              { status: 404 },
            );
      }) as unknown as typeof fetch;
      const s = new FcmSender(file, { fetchFn, now: () => 1_800_000_000_000 });
      const target = {
        token: "ftok",
        environment: "production" as const,
        app: "a",
      };
      expect(await s.send(target, msg)).toBe("ok");
      expect(await s.send(target, msg)).toBe("ok");
      expect(reqs.filter((r) => r.url.includes("oauth2"))).toHaveLength(1);
      const grant = new URLSearchParams(String(reqs[0]!.init.body));
      expect(grant.get("grant_type")).toBe(
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      );
      const [, claims] = grant.get("assertion")!.split(".");
      expect(
        JSON.parse(Buffer.from(claims!, "base64url").toString()),
      ).toMatchObject({
        iss: "sa@proj-1.iam.example",
        aud: "https://oauth2.googleapis.com/token",
      });
      const send = reqs.find((r) => r.url.includes("messages:send"))!;
      expect(send.url).toBe(
        "https://fcm.googleapis.com/v1/projects/proj-1/messages:send",
      );
      expect((send.init.headers as Record<string, string>).authorization).toBe(
        "Bearer at-1",
      );
      const m = JSON.parse(String(send.init.body)).message;
      expect(m.android).toEqual({
        priority: "HIGH",
        notification: { channel_id: "approvals" },
      });
      expect(m.data).toEqual({ kind: "approval", id: "ab" });
      sendStatus = 404;
      expect(await s.send(target, msg)).toBe("dead");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
