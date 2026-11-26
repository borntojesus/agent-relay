// Audit and Tokens.

import { api, errorText, seg } from "./api.ts";
import type { Changes, Ctx, View } from "./ctx.ts";
import { h, replace, stamp, tag, when } from "./dom.ts";
import { readOnlyNote } from "./inbox.ts";
import type { AuditEntry, TokenRow } from "./types.ts";

export function auditView(): View {
  const el = h("div", { class: "page" });
  let entries: AuditEntry[] = [];
  let error = "";
  let more = true;
  let lastCursor = -1;
  let filter = "";

  async function load(ctx: Ctx, reset: boolean) {
    try {
      const before = reset ? undefined : entries[entries.length - 1]?.id;
      const r = await api<{ entries: AuditEntry[] }>("GET", "/owner/audit", {
        query: { limit: 100, before },
      });
      entries = reset ? r.entries : entries.concat(r.entries);
      more = r.entries.length === 100;
      error = "";
    } catch (e) {
      error = errorText(e);
    }
    draw(ctx);
  }

  function draw(ctx: Ctx) {
    const q = filter.toLowerCase();
    const shown = q
      ? entries.filter((e) =>
          [e.actor, e.action, e.target ?? "", e.detail ?? ""].some((s) =>
            s.toLowerCase().includes(q),
          ),
        )
      : entries;
    const input = h("input", {
      placeholder: "Filter",
      value: filter,
      style: "width:220px",
    });
    input.addEventListener("input", () => {
      filter = input.value;
      draw(ctx);
      const again = el.querySelector("input");
      again?.focus();
      again?.setSelectionRange(filter.length, filter.length);
    });
    replace(
      el,
      h(
        "div",
        { class: "toolbar" },
        input,
        h("span", { class: "spacer" }),
        h("span", { class: "dim small" }, `${shown.length} rows`),
        h(
          "button",
          { class: "small", onclick: () => load(ctx, true) },
          "Reload",
        ),
      ),
      error && h("div", { class: "banner error" }, error),
      h(
        "div",
        { class: "boxed-list", style: "padding:0 4px" },
        h(
          "table",
          { class: "grid" },
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              ["Time", "Actor", "Action", "Target", "", "Detail"].map((c) =>
                h("th", null, c),
              ),
            ),
          ),
          h(
            "tbody",
            null,
            shown.map((e) =>
              h(
                "tr",
                null,
                h(
                  "td",
                  { title: stamp(e.at), style: "white-space:nowrap" },
                  when(e.at),
                ),
                h("td", { class: "mono" }, e.actor),
                h("td", { class: "mono" }, e.action),
                h("td", null, e.target ?? ""),
                h("td", null, e.ok ? tag("ok", "ok") : tag("failed", "danger")),
                h("td", { class: "text small selectable" }, e.detail ?? ""),
              ),
            ),
          ),
        ),
      ),
      more &&
        entries.length > 0 &&
        h(
          "div",
          { style: "text-align:center" },
          h("button", { onclick: () => load(ctx, false) }, "Load older"),
        ),
    );
  }

  return {
    title: "Audit",
    el,
    update(ctx: Ctx, _ch: Changes) {
      const cur = ctx.app.snapshot.summary.auditCursor;
      if (cur !== lastCursor) {
        lastCursor = cur;
        void load(ctx, true);
      } else if (lastCursor === -1) draw(ctx);
    },
  };
}

export function tokensView(): View {
  const el = h("div", { class: "page" });
  let tokens: TokenRow[] = [];
  let error = "";
  let showRevoked = false;
  let loaded = false;

  async function load(ctx: Ctx) {
    try {
      tokens = (
        await api<{ tokens: TokenRow[] }>("GET", "/owner/tokens", {
          query: { all: 1 },
        })
      ).tokens;
      error = "";
    } catch (e) {
      error = errorText(e);
    }
    loaded = true;
    draw(ctx);
  }

  async function revoke(ctx: Ctx, t: TokenRow) {
    if (
      !(await ctx.confirm(
        `Revoke ${t.label}?`,
        "The agent using this token loses access at once. This cannot be undone.",
        "Revoke",
        true,
      ))
    )
      return;
    try {
      await api("POST", `/owner/tokens/${seg(t.label)}/revoke`, { body: {} });
      ctx.toast(`${t.label} revoked.`);
    } catch (e) {
      ctx.toast(errorText(e));
    }
    await load(ctx);
  }

  function draw(ctx: Ctx) {
    const shown = tokens.filter((t) => showRevoked || !t.revokedAt);
    const grant = (g: TokenRow["grants"][number]) =>
      `${g.channel}:${g.read ? "r" : ""}${g.send ? "w" : ""}`;
    replace(
      el,
      !ctx.canSend && readOnlyNote(),
      h(
        "div",
        { class: "toolbar" },
        h(
          "label",
          { style: "display:flex;gap:6px;align-items:center" },
          h("input", {
            type: "checkbox",
            checked: showRevoked,
            onchange: (e: Event) => (
              (showRevoked = (e.target as HTMLInputElement).checked),
              draw(ctx)
            ),
          }),
          "Show revoked",
        ),
        h("span", { class: "spacer" }),
        h(
          "span",
          { class: "dim small" },
          "New tokens are created on the relay host with the admin CLI.",
        ),
        h("button", { class: "small", onclick: () => load(ctx) }, "Reload"),
      ),
      error && h("div", { class: "banner error" }, error),
      !loaded && h("div", { class: "empty" }, "Loading…"),
      loaded &&
        h(
          "div",
          { class: "boxed-list", style: "padding:0 4px" },
          h(
            "table",
            { class: "grid" },
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                [
                  "Label",
                  "Kind",
                  "Rooms",
                  "Grants",
                  "Created",
                  "Last used",
                  "",
                ].map((c) => h("th", null, c)),
              ),
            ),
            h(
              "tbody",
              null,
              shown.map((t) =>
                h(
                  "tr",
                  { class: t.revokedAt ? "revoked" : "" },
                  h(
                    "td",
                    null,
                    h("span", { class: "mono strong" }, t.label),
                    t.current && " ",
                    t.current && tag("this app", "accent"),
                  ),
                  h("td", null, t.kind),
                  h("td", { class: "small" }, t.rooms.join(", ")),
                  h(
                    "td",
                    { class: "mono small" },
                    t.grants.map(grant).join(" "),
                  ),
                  h(
                    "td",
                    { title: stamp(t.createdAt), style: "white-space:nowrap" },
                    when(t.createdAt),
                  ),
                  h(
                    "td",
                    { style: "white-space:nowrap" },
                    t.lastUsedAt ? when(t.lastUsedAt) : "never",
                  ),
                  h(
                    "td",
                    { style: "text-align:right" },
                    t.revokedAt
                      ? h(
                          "span",
                          { class: "dim small" },
                          `revoked ${when(t.revokedAt)}`,
                        )
                      : !t.current &&
                          h(
                            "button",
                            {
                              class: "destructive small",
                              disabled: !ctx.canSend,
                              onclick: () => revoke(ctx, t),
                            },
                            "Revoke",
                          ),
                  ),
                ),
              ),
            ),
          ),
        ),
    );
  }

  return {
    title: "Tokens",
    el,
    update(ctx: Ctx, ch: Changes) {
      if (!loaded) {
        draw(ctx);
        void load(ctx);
      } else if (!ch.any) draw(ctx);
    },
  };
}
