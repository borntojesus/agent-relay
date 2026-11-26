// Shell: sign-in, sidebar, header, banners, toast, confirm. State comes from
// the Rust core as `relay://state` events; views fetch their own detail
// through the `api` command.

import { listen } from "@tauri-apps/api/event";
import { core, errorText } from "./api.ts";
import { auditView, tokensView } from "./admin.ts";
import type { Changes, Ctx, Section, View } from "./ctx.ts";
import { countdown, h, replace, when } from "./dom.ts";
import { feedView, inboxView } from "./inbox.ts";
import { roomsCache, roomsView } from "./rooms.ts";
import { settingsView } from "./settings.ts";
import { loadTeams, teamView, teamsCache } from "./team.ts";
import type { AppView, OpenTarget } from "./types.ts";

const root = document.getElementById("app")!;

let app: AppView | null = null;
let section: Section = "inbox";
const views = new Map<Section, View>();
const busy = new Set<string>();
let lastFeed = -1;
let lastPending = "";
let toastTimer: number | undefined;
let signInBusy = false;
let signInError = "";
let keyringFailed = false;
let shellBuilt = false;

const NAV: Array<{ id: Section; label: string; glyph: string }> = [
  { id: "inbox", label: "Inbox", glyph: "✓" },
  { id: "rooms", label: "Rooms", glyph: "#" },
  { id: "feed", label: "Feed", glyph: "≡" },
  { id: "team", label: "Team", glyph: "👥" },
  { id: "audit", label: "Audit", glyph: "⌚" },
  { id: "tokens", label: "Tokens", glyph: "⚿" },
  { id: "settings", label: "Settings", glyph: "⚙" },
];

function make(s: Section): View {
  switch (s) {
    case "inbox":
      return inboxView();
    case "rooms":
      return roomsView();
    case "feed":
      return feedView();
    case "team":
      return teamView();
    case "audit":
      return auditView();
    case "tokens":
      return tokensView();
    case "settings":
      return settingsView();
  }
}

function view(s: Section): View {
  let v = views.get(s);
  if (!v) {
    v = make(s);
    views.set(s, v);
  }
  return v;
}

// ------------------------------------------------------------------ toast, confirm

function toast(text: string) {
  document.querySelector(".toast")?.remove();
  const el = h(
    "div",
    { class: "toast", role: "status" },
    h("span", null, text),
    h("button", { class: "small", onclick: () => el.remove() }, "Close"),
  );
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.remove(), 4500);
}

function confirmDialog(
  title: string,
  body: string,
  ok: string,
  destructive = false,
): Promise<boolean> {
  return new Promise((resolve) => {
    const dlg = h("dialog", null);
    const done = (v: boolean) => {
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    replace(
      dlg,
      h("h3", null, title),
      h("div", { class: "dim" }, body),
      h(
        "div",
        { class: "actions" },
        h("button", { onclick: () => done(false) }, "Cancel"),
        h(
          "button",
          {
            class: destructive ? "destructive" : "suggested",
            onclick: () => done(true),
          },
          ok,
        ),
      ),
    );
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      done(false);
    });
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}

// ------------------------------------------------------------------ context

function teams(): Array<{ id: string; name: string }> {
  if (teamsCache && teamsCache.length) return teamsCache;
  return app?.me?.teams ?? [];
}

function ctx(): Ctx {
  const a = app!;
  return {
    app: a,
    canSend: a.me?.token.send ?? false,
    nav,
    toast,
    confirm: confirmDialog,
    team: a.settings.team,
    setTeam,
    busy,
    redraw: () => render({ feed: false, pending: false, any: false }),
  };
}

function setTeam(id: string) {
  if (!app) return;
  app.settings.team = id;
  const s = app.settings;
  core
    .saveSettings({
      pollSeconds: s.pollSeconds,
      notifications: s.notifications,
      tray: s.tray,
      team: id,
    })
    .catch((e) => toast(errorText(e)));
  render({ feed: false, pending: false, any: false });
}

function nav(
  s: Section,
  opts: { room?: string; thread?: string; team?: string; flash?: string } = {},
) {
  if (opts.team !== undefined && app) app.settings.team = opts.team;
  section = s;
  const v = view(s);
  render({ feed: false, pending: false, any: false });
  v.focus?.(opts);
  if (opts.flash) render({ feed: false, pending: false, any: false });
}

// ------------------------------------------------------------------ sign in

function drawSignIn() {
  shellBuilt = false;
  views.clear();
  const a = app;
  const server = h("input", {
    value: a?.settings.server || "http://127.0.0.1:4960",
    placeholder: "https://relay.example.org",
    autocomplete: "off",
    spellcheck: "false",
  });
  const user = h("input", {
    value: a?.settings.owner ?? "",
    placeholder: "alice",
    autocomplete: "username",
    spellcheck: "false",
  });
  const token = h("input", {
    type: "password",
    placeholder: "console token",
    autocomplete: "off",
  });
  const go = async (sessionOnly: boolean) => {
    if (signInBusy) return;
    signInBusy = true;
    signInError = "";
    drawSignIn.refresh?.();
    try {
      await core.signIn(server.value, user.value, token.value, sessionOnly);
      keyringFailed = false;
      token.value = "";
    } catch (e) {
      const err = e as { message?: string; keyring?: boolean };
      signInError = err?.message ?? errorText(e);
      keyringFailed = !!err?.keyring;
    } finally {
      signInBusy = false;
      if (!app?.signedIn) drawSignIn.refresh?.();
    }
  };
  const status = h("div", null);
  const btn = h("button", { class: "suggested", type: "submit" }, "Sign in");
  drawSignIn.refresh = () => {
    btn.disabled = signInBusy;
    btn.textContent = signInBusy ? "Signing in…" : "Sign in";
    const msg = signInError || a?.signInMessage || "";
    replace(
      status,
      msg && h("div", { class: "error-text" }, msg),
      keyringFailed &&
        h(
          "div",
          { class: "dim small", style: "display:grid;gap:6px;margin-top:6px" },
          "Unlock the login keyring (Seahorse) and try again, or keep the token in memory until you quit.",
          h(
            "button",
            { type: "button", onclick: () => go(true) },
            "Keep for this session only",
          ),
        ),
    );
  };
  const form = h(
    "form",
    {
      class: "card",
      onsubmit: (e: Event) => {
        e.preventDefault();
        void go(false);
      },
    },
    h("img", { class: "logo", src: "/icon.svg", alt: "" }),
    h("h2", null, "Agent Relay"),
    h(
      "div",
      { class: "dim small", style: "text-align:center" },
      "Sign in with a console token from your relay admin.",
    ),
    h("label", { class: "field" }, "Server", server),
    h("label", { class: "field" }, "Username", user),
    h("label", { class: "field" }, "Console token", token),
    status,
    btn,
    h(
      "div",
      { class: "dim small", style: "text-align:center" },
      "The token is kept in the system keyring, never in a file.",
    ),
  );
  replace(root, h("div", { class: "signin" }, form));
  drawSignIn.refresh();
  (a?.settings.owner ? token : user).focus();
}
drawSignIn.refresh = undefined as undefined | (() => void);

// ------------------------------------------------------------------ shell

const sidebarHead = h("div", { class: "head" });
const navEl = h("nav", null);
const foot = h("div", { class: "foot" });
const title = h("h1", null);
const headerExtra = h("span", { class: "dim small" });
const banners = h("div", null);
const content = h("div", { class: "content" });

function buildShell() {
  shellBuilt = true;
  const refreshBtn = h(
    "button",
    {
      class: "icon flat",
      title: "Refresh (F5)",
      onclick: () => core.refresh(),
    },
    "⟳",
  );
  replace(
    root,
    h(
      "div",
      { class: "shell" },
      h("aside", { class: "sidebar" }, sidebarHead, navEl, foot),
      h(
        "main",
        { class: "main" },
        h(
          "div",
          { class: "headerbar" },
          title,
          headerExtra,
          h("span", { class: "spacer" }),
          refreshBtn,
        ),
        banners,
        content,
      ),
    ),
  );
}

function drawChrome(c: Ctx) {
  const a = c.app;
  const s = a.snapshot.summary;
  const ts = teams();
  replace(
    sidebarHead,
    h(
      "div",
      { class: "brand" },
      h("img", { src: "/icon.svg", alt: "" }),
      "Agent Relay",
    ),
    ts.length > 0 &&
      h(
        "select",
        {
          title: "Team",
          onchange: (e: Event) =>
            setTeam((e.target as HTMLSelectElement).value),
        },
        h("option", { value: "", selected: !a.settings.team }, "All rooms"),
        ts.map((t) =>
          h(
            "option",
            { value: t.id, selected: t.id === a.settings.team },
            t.name,
          ),
        ),
      ),
  );
  const pending = s.pendingPosts + s.pendingApprovals;
  const unread = c.team
    ? roomsCache
        .filter((r) => r.team === c.team)
        .reduce((n, r) => n + r.unread, 0)
    : s.unread;
  const counts: Partial<Record<Section, [number, string]>> = {
    inbox: [pending, "warn"],
    rooms: [unread, ""],
  };
  replace(
    navEl,
    NAV.map((n) => {
      const [count, kind] = counts[n.id] ?? [0, ""];
      return h(
        "button",
        {
          class: `navitem${n.id === section ? " active" : ""}`,
          onclick: () => nav(n.id),
        },
        h("span", { class: "glyph" }, n.glyph),
        n.label,
        count > 0 && h("span", { class: `count ${kind}` }, String(count)),
      );
    }),
  );
  const snap = a.snapshot;
  replace(
    foot,
    h(
      "div",
      null,
      h("span", { class: `dot${snap.online ? "" : " off"}` }),
      a.me ? a.me.owner.name : a.settings.owner,
    ),
    h(
      "div",
      { class: "small" },
      snap.online
        ? `synced ${snap.lastSync ? when(new Date(snap.lastSync).toISOString()) : "…"}`
        : a.connecting
          ? "connecting…"
          : "offline",
    ),
  );
  const v = view(section);
  title.textContent = v.title;
  const team = ts.find((t) => t.id === c.team);
  headerExtra.textContent =
    team && (section === "rooms" || section === "team") ? team.name : "";
  replace(
    banners,
    !snap.online &&
      !a.connecting &&
      h(
        "div",
        { class: "banner error" },
        `Cannot reach the relay: ${snap.lastError ?? "no answer"}. Retrying.`,
        h("button", { class: "small", onclick: () => core.refresh() }, "Retry"),
      ),
    a.sessionOnly &&
      h(
        "div",
        { class: "banner warn" },
        "The token is kept for this session only: the keyring refused it.",
      ),
  );
  document.title = pending > 0 ? `Agent Relay (${pending})` : "Agent Relay";
}

function render(ch: Changes) {
  if (!app) return;
  if (!app.signedIn) {
    if (shellBuilt || !root.querySelector(".signin")) drawSignIn();
    else drawSignIn.refresh?.();
    return;
  }
  if (!shellBuilt) buildShell();
  const c = ctx();
  drawChrome(c);
  const v = view(section);
  if (content.firstElementChild !== v.el) {
    content.replaceChildren(v.el);
    content.classList.toggle("full", !!v.full);
    content.style.overflow = v.full ? "hidden" : "auto";
  }
  v.update(c, ch);
}

function onState(next: AppView) {
  const wasSignedIn = app?.signedIn ?? false;
  // Keep a local team choice made before the save round-trips.
  app = next;
  if (!next.signedIn) {
    lastFeed = -1;
    lastPending = "";
    render({ feed: false, pending: false, any: true });
    return;
  }
  if (!wasSignedIn) {
    section = "inbox";
    void loadTeams()
      .then(() => render({ feed: false, pending: false, any: false }))
      .catch(() => {});
  }
  const s = next.snapshot.summary;
  const pendingKey = [
    ...next.snapshot.pending.posts.map((p) => `p${p.id}`),
    ...next.snapshot.pending.approvals.map((a) => `a${a.id}`),
  ].join(",");
  const ch: Changes = {
    feed: s.feedCursor !== lastFeed,
    pending: pendingKey !== lastPending,
    any: true,
  };
  lastFeed = s.feedCursor;
  lastPending = pendingKey;
  render(ch);
}

function openTarget(t: OpenTarget) {
  if (t.kind === "post") nav("inbox", { flash: `post:${t.id}` });
  else if (t.kind === "approval") nav("inbox", { flash: `approval:${t.id}` });
  else nav("rooms", { room: t.room, thread: t.thread });
}

// ------------------------------------------------------------------ boot

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "q") {
    e.preventDefault();
    void core.quit();
  } else if (
    e.key === "F5" ||
    ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r")
  ) {
    e.preventDefault();
    void core.refresh();
  } else if (
    (e.ctrlKey || e.metaKey) &&
    /^[1-7]$/.test(e.key) &&
    app?.signedIn
  ) {
    e.preventDefault();
    nav(NAV[Number(e.key) - 1].id);
  }
});

// Countdowns tick locally; no re-render.
setInterval(() => {
  const now = Date.now();
  for (const el of document.querySelectorAll<HTMLElement>("[data-countdown]")) {
    const at = el.dataset.countdown;
    if (at) el.textContent = countdown(at, now);
  }
}, 1000);

async function boot() {
  await listen<AppView>("relay://state", (e) => onState(e.payload));
  await listen<OpenTarget>("relay://open", (e) => openTarget(e.payload));
  await listen<string>("relay://error", (e) => toast(e.payload));
  onState(await core.state());
}

boot().catch((e) => {
  replace(
    root,
    h("div", { class: "empty" }, `Could not start: ${errorText(e)}`),
  );
});
