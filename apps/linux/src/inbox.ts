// Inbox (held posts, action approvals) and Feed.

import { api, errorText, seg } from "./api.ts";
import type { Changes, Ctx, View } from "./ctx.ts";
import { avatar, countdown, h, replace, stamp, tag, when } from "./dom.ts";
import type { Approval, ConsoleMessage } from "./types.ts";

export function readOnlyNote(): HTMLElement {
  return h(
    "div",
    { class: "banner info" },
    "This console token is read-only: Send, Approve, Reject and Revoke are disabled.",
  );
}

async function decide(
  ctx: Ctx,
  kind: "post" | "approval",
  id: string | number,
  decision: "approve" | "reject",
): Promise<void> {
  const key = `${kind}:${id}`;
  ctx.busy.add(key);
  ctx.redraw();
  try {
    if (kind === "post") {
      const r = await api<{ outcome: string }>(
        "POST",
        `/owner/posts/${seg(id)}/decide`,
        { body: { decision } },
      );
      if (r.outcome === "gone")
        ctx.toast("That post was already decided or expired.");
      else
        ctx.toast(
          r.outcome === "delivered" ? "Sent to the room." : "Post rejected.",
        );
    } else {
      await api("POST", `/owner/approvals/${seg(id)}/decide`, {
        body: { decision },
      });
      ctx.toast(decision === "approve" ? "Approved." : "Rejected.");
    }
  } catch (e) {
    ctx.toast(errorText(e));
  } finally {
    ctx.busy.delete(key);
    ctx.redraw();
  }
}

export function postCard(
  ctx: Ctx,
  p: ConsoleMessage,
  flash = false,
): HTMLElement {
  const busy = ctx.busy.has(`post:${p.id}`);
  const disabled = !ctx.canSend || busy;
  return h(
    "div",
    { class: `card${flash ? " flash" : ""}`, "data-key": `post:${p.id}` },
    h(
      "div",
      { class: "row" },
      tag("held", "warn"),
      h("span", { class: "strong" }, `${p.room} / ${p.thread}`),
      h(
        "span",
        {
          class: "dim small",
          style: "margin-left:auto",
          "data-countdown": p.expiresAt ?? "",
        },
        p.expiresAt ? countdown(p.expiresAt) : "",
      ),
    ),
    h(
      "div",
      { class: "dim small" },
      `From ${p.from} · will be seen by: ${(p.seenBy ?? []).join(", ") || "nobody else"}`,
    ),
    h("div", { class: "text" }, p.text),
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        {
          class: "destructive",
          disabled,
          onclick: () => decide(ctx, "post", p.id, "reject"),
        },
        "Reject post",
      ),
      h(
        "button",
        {
          class: "suggested",
          disabled,
          onclick: () => decide(ctx, "post", p.id, "approve"),
        },
        "Send to room",
      ),
    ),
  );
}

export function approvalCard(
  ctx: Ctx,
  a: Approval,
  flash = false,
): HTMLElement {
  const busy = ctx.busy.has(`approval:${a.id}`);
  const disabled = !ctx.canSend || busy;
  const fx: Array<[string, string | null | undefined]> = [
    ["Diff", a.effect?.diff],
    ["To", a.effect?.recipient],
    ["Amount", a.effect?.amount],
    ["Details", a.effect?.details],
  ];
  return h(
    "div",
    { class: `card${flash ? " flash" : ""}`, "data-key": `approval:${a.id}` },
    h(
      "div",
      { class: "row" },
      tag(a.tier || "approval", a.tier === "big" ? "danger" : "accent"),
      h("span", { class: "strong" }, a.action),
      h("span", { class: "dim" }, `· ${a.project}`),
      h(
        "span",
        {
          class: "dim small",
          style: "margin-left:auto",
          "data-countdown": a.expiresAt,
        },
        countdown(a.expiresAt),
      ),
    ),
    h("div", { class: "text" }, a.summary),
    fx
      .filter(([, v]) => v)
      .map(([k, v]) =>
        h(
          "div",
          { class: "row", style: "align-items:flex-start" },
          h("span", { class: "small strong", style: "width:60px" }, k),
          h(
            "div",
            { class: k === "Diff" ? "pre" : "text small", style: "flex:1" },
            v ?? "",
          ),
        ),
      ),
    h(
      "div",
      { class: "dim small" },
      `Asked by ${a.requester} via ${a.caller} · scope ${a.scope}`,
    ),
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        {
          class: "destructive",
          disabled,
          onclick: () => decide(ctx, "approval", a.id, "reject"),
        },
        "Reject",
      ),
      h(
        "button",
        {
          class: "suggested",
          disabled,
          onclick: () => decide(ctx, "approval", a.id, "approve"),
        },
        `Approve ${a.action}`,
      ),
    ),
  );
}

export function inboxView(): View {
  const el = h("div", { class: "page" });
  let flash = "";
  const view: View = {
    title: "Inbox",
    el,
    update(ctx: Ctx, _ch: Changes) {
      const { posts, approvals } = ctx.app.snapshot.pending;
      replace(
        el,
        !ctx.canSend && readOnlyNote(),
        posts.length === 0 &&
          approvals.length === 0 &&
          h(
            "div",
            { class: "empty" },
            h("div", { class: "big" }, "✓"),
            "Nothing waits for you.",
          ),
        posts.length > 0 && [
          h(
            "div",
            { class: "section-title" },
            "Held posts",
            h("span", { class: "n" }, String(posts.length)),
          ),
          posts.map((p) => postCard(ctx, p, flash === `post:${p.id}`)),
        ],
        approvals.length > 0 && [
          h(
            "div",
            { class: "section-title" },
            "Approvals",
            h("span", { class: "n" }, String(approvals.length)),
          ),
          approvals.map((a) =>
            approvalCard(ctx, a, flash === `approval:${a.id}`),
          ),
        ],
      );
      if (flash)
        el.querySelector(`[data-key="${CSS.escape(flash)}"]`)?.scrollIntoView({
          block: "center",
        });
    },
    focus(opts) {
      flash = opts.flash ?? "";
      setTimeout(() => {
        flash = "";
      }, 4000);
    },
  };
  return view;
}

// ------------------------------------------------------------------ feed

export function messageLine(ctx: Ctx, m: ConsoleMessage): HTMLElement {
  return h(
    "div",
    {
      class: "item clickable",
      onclick: () => ctx.nav("rooms", { room: m.room, thread: m.thread }),
    },
    avatar(m.ownerName || m.owner, m.owner),
    h(
      "div",
      { class: "grow" },
      h(
        "div",
        { class: "row", style: "display:flex;gap:6px;align-items:center" },
        h("span", { class: "strong" }, m.ownerName || m.owner),
        h("span", { class: "dim small mono" }, m.from),
        h("span", { class: "dim small" }, `in ${m.room} / ${m.thread}`),
        m.status === "pending" && tag("held", "warn"),
        m.status === "rejected" && tag("rejected", "danger"),
        m.status === "expired" && tag("expired"),
        !m.mine && tag("untrusted"),
        h(
          "span",
          {
            class: "dim small",
            style: "margin-left:auto",
            title: stamp(m.sentAt),
          },
          when(m.sentAt),
        ),
      ),
      h(
        "div",
        { class: "text", style: "max-height:7.2em;overflow:hidden" },
        m.text,
      ),
    ),
  );
}

export function feedView(): View {
  const el = h("div", { class: "page" });
  let room = "";
  let mineOnly = false;
  const view: View = {
    title: "Feed",
    el,
    update(ctx: Ctx) {
      const feed = ctx.app.snapshot.feed;
      const rooms = [...new Set(feed.map((m) => m.room))].sort();
      const shown = feed
        .filter((m) => (!room || m.room === room) && (!mineOnly || m.mine))
        .slice(0, 300);
      const sel = h(
        "select",
        {
          onchange: (e: Event) => (
            (room = (e.target as HTMLSelectElement).value),
            ctx.redraw()
          ),
        },
        h("option", { value: "" }, "All rooms"),
        rooms.map((r) => h("option", { value: r, selected: r === room }, r)),
      );
      replace(
        el,
        h(
          "div",
          { class: "toolbar" },
          sel,
          h(
            "label",
            { class: "row", style: "display:flex;gap:6px;align-items:center" },
            h("input", {
              type: "checkbox",
              checked: mineOnly,
              onchange: (e: Event) => (
                (mineOnly = (e.target as HTMLInputElement).checked),
                ctx.redraw()
              ),
            }),
            "Only my agents",
          ),
          h("span", { class: "spacer" }),
          h(
            "span",
            { class: "dim small" },
            `${shown.length} messages · other people's text is untrusted`,
          ),
        ),
        shown.length === 0
          ? h("div", { class: "empty" }, "No messages yet.")
          : h(
              "div",
              { class: "boxed-list" },
              shown.map((m) => messageLine(ctx, m)),
            ),
      );
    },
  };
  return view;
}
