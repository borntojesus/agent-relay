// Settings: poll interval, notifications, tray, account, sign out.

import { core, errorText } from "./api.ts";
import type { Changes, Ctx, View } from "./ctx.ts";
import { h, replace, when } from "./dom.ts";

export function settingsView(): View {
  const el = h("div", { class: "page" });

  async function save(
    ctx: Ctx,
    patch: Partial<{
      pollSeconds: number;
      notifications: boolean;
      tray: boolean;
    }>,
  ) {
    const s = ctx.app.settings;
    try {
      await core.saveSettings({
        pollSeconds: patch.pollSeconds ?? s.pollSeconds,
        notifications: patch.notifications ?? s.notifications,
        tray: patch.tray ?? s.tray,
        team: s.team,
      });
      ctx.toast("Saved.");
    } catch (e) {
      ctx.toast(errorText(e));
    }
  }

  function row(title: string, sub: string, control: HTMLElement) {
    return h(
      "div",
      { class: "item" },
      h(
        "div",
        { class: "grow" },
        h("div", { class: "strong" }, title),
        h("div", { class: "dim small" }, sub),
      ),
      control,
    );
  }

  function draw(ctx: Ctx) {
    const s = ctx.app.settings;
    const me = ctx.app.me;
    const poll = h(
      "select",
      {
        onchange: (e: Event) =>
          save(ctx, {
            pollSeconds: Number((e.target as HTMLSelectElement).value),
          }),
      },
      [2, 5, 10, 15, 30, 60].map((n) =>
        h(
          "option",
          { value: String(n), selected: n === s.pollSeconds },
          `${n} s`,
        ),
      ),
    );
    const notif = h("input", {
      type: "checkbox",
      class: "switch",
      checked: s.notifications,
      onchange: (e: Event) =>
        save(ctx, { notifications: (e.target as HTMLInputElement).checked }),
    });
    const tray = h("input", {
      type: "checkbox",
      class: "switch",
      checked: s.tray,
      onchange: (e: Event) =>
        save(ctx, { tray: (e.target as HTMLInputElement).checked }),
    });
    const snap = ctx.app.snapshot;
    replace(
      el,
      h("div", { class: "section-title" }, "Account"),
      h(
        "div",
        { class: "boxed-list" },
        h(
          "div",
          { class: "item" },
          h(
            "div",
            { class: "grow" },
            h(
              "div",
              { class: "strong" },
              me ? `${me.owner.name} (${me.owner.id})` : s.owner,
            ),
            h("div", { class: "dim small mono" }, ctx.app.server),
            me &&
              h(
                "div",
                { class: "dim small" },
                `Token ${me.token.label} · ${me.token.send ? "read and send" : "read-only"} · relay ${me.version} · Telegram ${me.channels.telegram ? "on" : "off"}`,
              ),
          ),
          h(
            "button",
            {
              class: "destructive",
              onclick: async () => {
                if (
                  await ctx.confirm(
                    "Sign out?",
                    "The token is removed from the keyring. You need it again to sign back in.",
                    "Sign out",
                    true,
                  )
                )
                  await core.signOut();
              },
            },
            "Sign out",
          ),
        ),
        h(
          "div",
          { class: "item" },
          h(
            "div",
            { class: "grow dim small" },
            ctx.app.sessionOnly
              ? "The token is kept for this session only (the keyring refused it). You will sign in again after a restart."
              : "The token is stored in the Secret Service keyring (GNOME Keyring / KWallet), service org.antonyuk.agent-relay. The window never sees it.",
          ),
        ),
      ),
      h("div", { class: "section-title" }, "Updates"),
      h(
        "div",
        { class: "boxed-list" },
        row(
          "Check every",
          "How often the app asks the relay for news. Errors back off to 30 s.",
          poll,
        ),
        row(
          "Desktop notifications",
          "New held posts and approvals, with Send / Reject buttons where the desktop supports them.",
          notif,
        ),
        row(
          "Tray icon",
          "Shows the pending count. On GNOME it needs the AppIndicator extension.",
          tray,
        ),
        h(
          "div",
          { class: "item" },
          h(
            "div",
            { class: "grow dim small" },
            snap.online
              ? `Online · last sync ${snap.lastSync ? when(new Date(snap.lastSync).toISOString()) : "never"}`
              : `Offline · ${snap.lastError ?? "no answer yet"}`,
          ),
          h(
            "button",
            { class: "small", onclick: () => core.refresh() },
            "Refresh now",
          ),
        ),
      ),
      h("div", { class: "section-title" }, "App"),
      h(
        "div",
        { class: "boxed-list" },
        h(
          "div",
          { class: "item" },
          h(
            "div",
            { class: "grow dim small" },
            `Agent Relay ${ctx.app.version} for Linux. Closing the window keeps it running in the background; Quit stops it.`,
          ),
          h("button", { onclick: () => core.quit() }, "Quit"),
        ),
      ),
    );
  }

  return {
    title: "Settings",
    el,
    update(ctx: Ctx, _ch: Changes) {
      // Do not redraw under an open select on every poll.
      if (
        el.contains(document.activeElement) &&
        document.activeElement?.tagName === "SELECT"
      )
        return;
      draw(ctx);
    },
  };
}
