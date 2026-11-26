// End-to-end smoke test against a running relay over MCP.
// Every token posts one message to a shared room, then each checks that it sees
// the others' messages (not its own) as unread, acks them, and sees zero unread.
//
//   RELAY_URL=http://<host>:<port>/mcp RELAY_ROOM=<room> \
//   RELAY_TOKENS="<name>=<token>,<name>=<token>,..." node scripts/smoke.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.RELAY_URL;
const room = process.env.RELAY_ROOM;
const tokens = (process.env.RELAY_TOKENS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const i = s.indexOf("=");
    return { name: s.slice(0, i), token: s.slice(i + 1) };
  });
if (!url || !room || tokens.length < 2) {
  console.error(
    "Set RELAY_URL, RELAY_ROOM and RELAY_TOKENS (at least two name=token pairs).",
  );
  process.exit(2);
}

type Json = Record<string, any>;
const thread = `smoke-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;

async function connect(token: string) {
  const client = new Client({ name: "relay-smoke", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url!), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Json): Promise<Json> {
  const res = (await client.callTool({ name, arguments: args })) as Json;
  const text = res.content?.find((c: Json) => c.type === "text")?.text ?? "{}";
  if (res.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text.replace(/^[^{[]*/, ""));
}

let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failed++;
};

const agents = await Promise.all(
  tokens.map(async (t) => ({
    ...t,
    client: await connect(t.token),
    postId: 0,
  })),
);

for (const a of agents) {
  const tools = (await a.client.listTools()).tools.map((t) => t.name);
  check(
    tools.includes("peer_post") && tools.includes("peer_unread"),
    `${a.name}: tools listed (${tools.length})`,
  );
  // Start clean so older traffic does not skew the counts.
  await call(a.client, "peer_ack", { room, all: true });
}

for (const a of agents) {
  const r = await call(a.client, "peer_post", {
    room,
    thread,
    text: `smoke from ${a.name}`,
  });
  a.postId = Number(r.id);
  check(r.status === "delivered", `${a.name}: post ${r.id} status ${r.status}`);
}

for (const a of agents) {
  const u = await call(a.client, "peer_unread", { room, thread });
  const texts: string[] = (u.messages ?? []).map((m: Json) => m.text);
  const want = agents.filter((o) => o !== a).map((o) => `smoke from ${o.name}`);
  check(
    want.every((w) => texts.includes(w)),
    `${a.name}: sees ${want.length} others' posts`,
  );
  check(
    !texts.includes(`smoke from ${a.name}`),
    `${a.name}: own post not in its unread`,
  );
  const ack = await call(a.client, "peer_ack", { room, thread });
  check(
    ack.unread === 0,
    `${a.name}: acked ${ack.acknowledged}, unread now ${ack.unread}`,
  );
}

// Per-token read state: the first agent acking must not have cleared anyone else.
const history = await call(agents[0].client, "peer_read", { room, thread });
for (const m of history.messages ?? []) {
  const readBy: string[] = m.readBy ?? [];
  check(
    readBy.length === agents.length - 1,
    `message ${m.id} from ${m.from}: readBy ${readBy.join(", ")}`,
  );
}

for (const a of agents) await a.client.close();
console.log(
  failed
    ? `\n${failed} check(s) failed`
    : `\nall checks passed (room ${room}, thread ${thread})`,
);
process.exit(failed ? 1 : 0);
