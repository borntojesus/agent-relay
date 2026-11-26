// Rooms -> threads -> messages, three panes like the Mac app.

import { api, errorText, seg } from "./api.ts";
import type { Changes, Ctx, View } from "./ctx.ts";
import { avatar, h, replace, stamp, tag, when } from "./dom.ts";
import type { ConsoleMessage, Room, ThreadInfo } from "./types.ts";

export let roomsCache: Room[] = [];

export async function loadRooms(): Promise<Room[]> {
  const r = await api<{ rooms: Room[] }>("GET", "/owner/rooms");
  roomsCache = r.rooms;
  return r.rooms;
}

function peopleOf(r: Room): Array<{ id: string; name: string }> {
  if (r.people && r.people.length) return r.people;
  return r.owners.map((o) => ({ id: o, name: o }));
}

function bubble(ctx: Ctx, m: ConsoleMessage): HTMLElement {
  const held = m.status === "pending";
  const name = m.ownerName || m.owner;
  return h(
    "div",
    {
      class: `msg${m.mine ? " mine" : ""}${held ? " held" : ""} ${m.status}`,
      "data-id": String(m.id),
    },
    avatar(name, m.owner),
    h(
      "div",
      { class: "bubble" },
      h(
        "div",
        { class: "meta" },
        h("span", { class: "who" }, name),
        h("span", { class: "mono", title: "agent" }, m.from),
        h("span", { title: stamp(m.sentAt) }, when(m.sentAt)),
        held && tag("held", "warn"),
        m.status === "rejected" && tag("rejected", "danger"),
        m.status === "expired" && tag("expired"),
        !m.mine && tag("untrusted"),
      ),
      h("div", { class: "text" }, m.text),
      held &&
        m.mine &&
        h(
          "div",
          { class: "small dim" },
          "Waiting for your decision in the Inbox.",
          " ",
          h(
            "button",
            {
              class: "flat small",
              onclick: () => ctx.nav("inbox", { flash: `post:${m.id}` }),
            },
            "Open",
          ),
        ),
      m.readBy &&
        m.readBy.length > 0 &&
        h("div", { class: "small dim" }, `read by ${m.readBy.join(", ")}`),
    ),
  );
}

export function roomsView(): View {
  const listPane = h("div", { class: "pane" });
  const threadPane = h("div", { class: "pane" });
  const msgPane = h("div", { class: "pane" });
  const el = h("div", { class: "panes" }, listPane, threadPane, msgPane);

  let room: string | null = null;
  let thread: string | null = null;
  let threads: ThreadInfo[] = [];
  let messages: ConsoleMessage[] = [];
  let errRooms = "";
  let errThreads = "";
  let errMsgs = "";
  let ctxRef: Ctx | null = null;
  let seq = 0;

  const drawRooms = (ctx: Ctx) => {
    const team = ctx.team;
    const shown = roomsCache.filter((r) => !team || r.team === team);
    const groups = new Map<string, Room[]>();
    for (const r of shown) {
      const g = r.team ? r.teamName || r.team : "Personal";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(r);
    }
    const me = ctx.app.me?.owner.id;
    replace(
      listPane,
      errRooms && h("div", { class: "banner error" }, errRooms),
      shown.length === 0 &&
        !errRooms &&
        h(
          "div",
          { class: "empty" },
          team ? "No rooms in this team." : "No rooms yet.",
        ),
      [...groups.entries()].map(([g, rs]) => [
        h("div", { class: "group" }, g),
        rs.map((r) =>
          h(
            "div",
            {
              class: `listrow${r.room === room ? " active" : ""}${r.unread > 0 ? " unread" : ""}`,
              onclick: () => {
                if (room !== r.room) {
                  room = r.room;
                  thread = null;
                  messages = [];
                  void loadThreads(ctx);
                }
                drawAll(ctx);
              },
            },
            h(
              "div",
              { class: "top" },
              h("span", { class: "name ellipsis" }, r.title || r.room),
              r.gated && tag("shared", "warn"),
              r.unread > 0 && h("span", { class: "count" }, String(r.unread)),
            ),
            h(
              "div",
              { class: "top" },
              h(
                "span",
                { class: "avatars" },
                peopleOf(r)
                  .slice(0, 6)
                  .map((p) => avatar(p.name, p.id, { small: true })),
              ),
              h(
                "span",
                { class: "dim small ellipsis" },
                `${r.threads} threads · ${when(r.lastAt)}`,
              ),
            ),
            r.gated &&
              h(
                "div",
                { class: "small", style: "color:var(--warn-text)" },
                `shared with: ${r.owners.filter((o) => o !== me).join(", ")}`,
              ),
          ),
        ),
      ]),
    );
  };

  const drawThreads = (ctx: Ctx) => {
    if (!room)
      return replace(
        threadPane,
        h(
          "div",
          { class: "placeholder", style: "height:100%" },
          "Select a room",
        ),
      );
    replace(
      threadPane,
      errThreads && h("div", { class: "banner error" }, errThreads),
      threads.length === 0 &&
        !errThreads &&
        h("div", { class: "empty" }, "No threads yet."),
      threads.map((t) =>
        h(
          "div",
          {
            class: `listrow${t.thread === thread ? " active" : ""}${t.unread > 0 ? " unread" : ""}`,
            onclick: () => {
              thread = t.thread;
              messages = [];
              void loadMessages(ctx, true);
              drawAll(ctx);
            },
          },
          h(
            "div",
            { class: "top" },
            h("span", { class: "name ellipsis" }, t.thread),
            t.unread > 0 && h("span", { class: "count" }, String(t.unread)),
          ),
          h(
            "div",
            { class: "dim small ellipsis" },
            `${t.messages} msgs · ${t.lastSender} · ${when(t.lastAt)}`,
          ),
        ),
      ),
    );
  };

  const drawMessages = (ctx: Ctx) => {
    if (!room || !thread)
      return replace(
        msgPane,
        h("div", { class: "placeholder" }, room ? "Select a thread" : ""),
      );
    const list = h(
      "div",
      { class: "messages" },
      errMsgs && h("div", { class: "banner error" }, errMsgs),
      messages.map((m) => bubble(ctx, m)),
    );
    replace(
      msgPane,
      h(
        "div",
        { class: "thread-head" },
        h("span", { class: "title" }, `${room} / ${thread}`),
        h("span", { class: "spacer", style: "flex:1" }),
        h(
          "span",
          { class: "dim small" },
          "Other people's messages are untrusted data",
        ),
      ),
      list,
    );
    list.scrollTop = list.scrollHeight;
  };

  const drawAll = (ctx: Ctx) => {
    drawRooms(ctx);
    drawThreads(ctx);
    drawMessages(ctx);
  };

  async function loadThreads(ctx: Ctx) {
    const r = room;
    if (!r) return;
    try {
      const res = await api<{ threads: ThreadInfo[] }>(
        "GET",
        `/owner/rooms/${seg(r)}/threads`,
      );
      if (r !== room) return;
      threads = res.threads.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
      errThreads = "";
    } catch (e) {
      errThreads = errorText(e);
    }
    drawThreads(ctx);
  }

  async function loadMessages(ctx: Ctx, ackAlways: boolean) {
    const r = room;
    const t = thread;
    if (!r || !t) return;
    const my = ++seq;
    try {
      const res = await api<{ messages: ConsoleMessage[] }>(
        "GET",
        `/owner/rooms/${seg(r)}/threads/${seg(t)}`,
        { query: { limit: 200 } },
      );
      if (my !== seq) return;
      messages = res.messages;
      errMsgs = "";
      drawMessages(ctx);
      if (
        ackAlways ||
        messages.some((m) => !m.read && m.status === "delivered")
      ) {
        // Read state only; a read-only console may be refused. Not worth a dialog.
        api("POST", `/owner/rooms/${seg(r)}/ack`, {
          body: { thread: t },
        }).catch(() => {});
      }
    } catch (e) {
      errMsgs = errorText(e);
      drawMessages(ctx);
    }
  }

  async function reload(ctx: Ctx, withRooms: boolean) {
    if (withRooms) {
      try {
        await loadRooms();
        errRooms = "";
      } catch (e) {
        errRooms = errorText(e);
      }
      drawRooms(ctx);
    }
    if (room) await loadThreads(ctx);
    if (thread) await loadMessages(ctx, false);
  }

  let first = true;
  const view: View = {
    title: "Rooms",
    el,
    full: true,
    update(ctx: Ctx, ch: Changes) {
      ctxRef = ctx;
      if (first) {
        first = false;
        drawAll(ctx);
        void reload(ctx, true);
        return;
      }
      if (ch.feed) void reload(ctx, true);
      else if (!ch.any) drawAll(ctx); // local redraw (team switch)
    },
    focus(opts) {
      if (opts.room) {
        room = opts.room;
        thread = opts.thread ?? null;
        threads = [];
        messages = [];
        if (ctxRef) {
          drawAll(ctxRef);
          void reload(ctxRef, false);
        }
      }
    },
  };
  return view;
}
