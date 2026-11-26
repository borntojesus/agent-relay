import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/http/server.ts';
import { world } from './helpers.ts';

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  while (servers.length) servers.pop()!.close();
});

async function up(w = world(), opts: Parameters<typeof createHttpServer>[1] = {}) {
  const server = createHttpServer(w.relay, opts);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, token?: string, init: RequestInit = {}) =>
    fetch(base + path, {
      ...init,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  const mcp = async (token: string) => {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    servers.push({ close: () => void client.close() });
    return client;
  };
  return { w, base, call, mcp };
}

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]!.text);

describe('http', () => {
  it('answers health without a token and lists channels', async () => {
    const { call } = await up();
    const r = await call('/health');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, service: 'agent-relay', channels: ['alice', 'bob'] });
  });

  it('refuses a missing or unknown bearer and locks out an IP that keeps guessing', async () => {
    const { w, call } = await up();
    expect((await call('/unread')).status).toBe(401);
    for (let i = 0; i < 9; i++) await call('/unread', 'nope');
    expect((await call('/unread', 'nope')).status).toBe(429);
    const good = w.agent('mac-a', 'alice', 'peer:team:rw');
    expect((await call('/unread', good.token)).status).toBe(429);
    expect(w.relay.audit.recent().some((a) => a.action === 'auth' && !a.ok)).toBe(true);
  });

  it('serves unread for a hook as text or json', async () => {
    const { w, call } = await up();
    const a = w.agent('mac-a', 'alice', 'peer:team:rw');
    const b = w.agent('mac-b', 'alice', 'peer:team:rw');
    expect(await (await call('/unread', b.token)).text()).toBe('');
    await w.relay.rooms.for(a.caller)!.post({ room: 'team', thread: 'build', text: 'green' });
    expect(await (await call('/unread', b.token)).text()).toContain('green');
    const j = (await (await call('/unread?format=json', b.token)).json()) as { _trust: string; unread: number };
    expect(j).toMatchObject({ _trust: 'untrusted', unread: 1 });
    const none = w.agent('ops', 'alice', 'approval:ops:w');
    expect(await (await call('/unread?format=json', none.token)).json()).toEqual({ messages: [], unread: 0, more: false });
  });

  it('runs approvals over REST', async () => {
    const { w, call } = await up();
    const a = w.agent('mac-a', 'alice', 'approval:ops:w');
    const body = { project: 'web-app', action: 'task.create', summary: 'open a task', requester: 'mac-a' };
    const created = await call('/approvals', a.token, { method: 'POST', body: JSON.stringify(body) });
    expect(created.status).toBe(201);
    const v = (await created.json()) as { id: string; status: string };
    expect(v.status).toBe('pending');
    expect((await (await call(`/approvals/${v.id}`, a.token)).json()) as object).toMatchObject({ id: v.id });
    const decided = await call(`/approvals/${v.id}/decide`, a.token, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) });
    expect(((await decided.json()) as { status: string }).status).toBe('approved');
    expect(((await (await call('/approvals', a.token)).json()) as { approvals: unknown[] }).approvals).toHaveLength(1);
    expect((await call('/approvals', a.token, { method: 'POST', body: JSON.stringify({ ...body, action: 'Bad!' }) })).status).toBe(400);
    const other = w.agent('other', 'alice', 'approval:ops:w');
    expect((await call(`/approvals/${v.id}`, other.token)).status).toBe(404);
    const noScope = w.agent('reader', 'alice', 'peer:team:r');
    expect((await call('/approvals', noScope.token, { method: 'POST', body: JSON.stringify(body) })).status).toBe(403);
  });

  it('lists only the MCP tools a token\'s grants reach', async () => {
    const { w, mcp } = await up();
    const rooms = w.agent('mac-a', 'alice', 'peer:team:rw');
    const ops = w.agent('ops', 'alice', 'approval:ops:w');
    const names = async (t: string) => (await (await mcp(t)).listTools()).tools.map((x) => x.name).sort();
    const r = await names(rooms.token);
    expect(r).toContain('peer_post');
    expect(r).not.toContain('approval_request');
    const o = await names(ops.token);
    expect(o).toContain('approval_request');
    expect(o).not.toContain('peer_post');
  });

  it('posts and reads through MCP, marks results untrusted and audits writes', async () => {
    const { w, mcp } = await up();
    const a = w.agent('mac-a', 'alice', 'peer:team:rw');
    const b = w.agent('mac-b', 'alice', 'peer:team:rw');
    const ca = await mcp(a.token);
    const posted = JSON.parse(text(await ca.callTool({ name: 'peer_post', arguments: { room: 'team', thread: 'build', text: 'hello' } })));
    expect(posted.status).toBe('delivered');
    const cb = await mcp(b.token);
    const unread = JSON.parse(text(await cb.callTool({ name: 'peer_unread', arguments: {} })));
    expect(unread._trust).toBe('untrusted');
    expect(unread.messages[0].text).toBe('hello');
    const bad = await cb.callTool({ name: 'peer_post', arguments: { room: 'nowhere', thread: 'x', text: 'y' } });
    expect(bad.isError).toBe(true);
    const audit = w.relay.audit.recent();
    expect(audit.some((x) => x.action === 'mcp:peer_post' && x.ok)).toBe(true);
    expect(audit.some((x) => x.action === 'mcp:peer_post' && !x.ok)).toBe(true);
  });

  it('refuses GET on /mcp', async () => {
    const { w, call } = await up();
    const a = w.agent('mac-a', 'alice', 'peer:team:rw');
    expect((await call('/mcp', a.token)).status).toBe(405);
  });
  it('behind a proxy keys the lockout on CF-Connecting-IP, not the proxy address', async () => {
    const { w, call } = await up(world(), { trustProxy: true });
    const from = (ip: string) => ({ headers: { 'CF-Connecting-IP': ip, 'X-Forwarded-For': '10.0.0.1' } });
    for (let i = 0; i < 10; i++) await call('/unread', 'nope', from('203.0.113.7'));
    expect((await call('/unread', 'nope', from('203.0.113.7'))).status).toBe(429);
    const good = w.agent('mac-a', 'alice', 'peer:team:rw');
    expect((await call('/unread', good.token, from('198.51.100.9'))).status).toBe(200);
  });
});
