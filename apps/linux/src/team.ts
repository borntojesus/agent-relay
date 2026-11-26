// Team: members, invites (placeholders, shown as "Invited"), gate, rooms, and
// the admin actions of the 0.4.0 contract (rename, gate, add/remove member,
// invite/uninvite). Tolerates a relay without teams (404 on /owner/teams).

import { ApiError, api, errorText, seg } from "./api.ts";
import type { Changes, Ctx, View } from "./ctx.ts";
import { avatar, h, replace, tag } from "./dom.ts";
import { roomsCache } from "./rooms.ts";
import type { Team } from "./types.ts";

export let teamsCache: Team[] | null = null;
export let teamsUnsupported = false;

export async function loadTeams(): Promise<Team[]> {
  try {
    const r = await api<{ teams: Team[] }>("GET", "/owner/teams");
    teamsCache = r.teams;
    teamsUnsupported = false;
    return r.teams;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      teamsUnsupported = true;
      teamsCache = [];
      return [];
    }
    throw e;
  }
}

export function teamView(): View {
  const el = h("div", { class: "page" });
  let error = "";
  let loaded = false;
  let renaming = false;

  async function act(ctx: Ctx, label: string, fn: () => Promise<unknown>) {
    ctx.busy.add("team");
    draw(ctx);
    try {
      await fn();
      ctx.toast(label);
      await loadTeams();
      error = "";
    } catch (e) {
      ctx.toast(errorText(e));
    } finally {
      ctx.busy.delete("team");
      draw(ctx);
    }
  }

  function draw(ctx: Ctx) {
    if (!loaded) return replace(el, h("div", { class: "empty" }, "Loading…"));
    if (teamsUnsupported)
      return replace(
        el,
        h(
          "div",
          { class: "empty" },
          h("div", { class: "big" }, "👥"),
          "This relay has no teams yet.",
          h(
            "div",
            { class: "small" },
            "Teams need agent-relay 0.4.0 on the server.",
          ),
        ),
      );
    const teams = teamsCache ?? [];
    if (teams.length === 0)
      return replace(
        el,
        error && h("div", { class: "banner error" }, error),
        h(
          "div",
          { class: "empty" },
          h("div", { class: "big" }, "👥"),
          "You are not in a team.",
          h(
            "div",
            { class: "small" },
            "An admin adds you with: relay team member <team> <username>",
          ),
        ),
      );
    const t = teams.find((x) => x.id === ctx.team) ?? teams[0];
    const admin = t.role === "admin" && ctx.canSend;
    const busy = ctx.busy.has("team");
    const me = ctx.app.me?.owner.id;
    const admins = t.members.filter((m) => m.role === "admin").length;

    const nameInput = h("input", { value: t.name, style: "flex:1" });
    const header = renaming
      ? h(
          "div",
          { class: "row" },
          nameInput,
          h(
            "button",
            { onclick: () => ((renaming = false), draw(ctx)) },
            "Cancel",
          ),
          h(
            "button",
            {
              class: "suggested",
              disabled: busy,
              onclick: () => {
                const name = nameInput.value.trim();
                if (!name) return;
                renaming = false;
                void act(ctx, "Team renamed.", () =>
                  api("PATCH", `/owner/teams/${seg(t.id)}`, { body: { name } }),
                );
              },
            },
            "Save",
          ),
        )
      : h(
          "div",
          { class: "row" },
          h("span", { style: "font-size:20px;font-weight:700" }, t.name),
          h("span", { class: "dim mono small" }, t.id),
          tag(t.role, t.role === "admin" ? "accent" : ""),
          admin &&
            h(
              "button",
              {
                class: "flat small",
                style: "margin-left:auto",
                onclick: () => ((renaming = true), draw(ctx)),
              },
              "Rename",
            ),
        );

    const gate = h(
      "div",
      { class: "card" },
      h(
        "div",
        { class: "row" },
        h(
          "div",
          { class: "grow", style: "flex:1" },
          h("div", { class: "strong" }, "Gate for posts between members"),
          h(
            "div",
            { class: "dim small" },
            t.gate === "on"
              ? "On: a post seen by another owner waits for its owner to tap Send."
              : "Off: posts in team rooms go straight through when everyone else in the room is a member.",
          ),
        ),
        h("input", {
          type: "checkbox",
          class: "switch",
          checked: t.gate === "on",
          disabled: !admin || busy,
          title: admin ? "" : "Only team admins change the gate",
          onchange: (e: Event) => {
            const on = (e.target as HTMLInputElement).checked;
            void act(ctx, `Gate ${on ? "on" : "off"}.`, () =>
              api("PATCH", `/owner/teams/${seg(t.id)}`, {
                body: { gate: on ? "on" : "off" },
              }),
            );
          },
        }),
      ),
    );

    const invites = t.invites ?? [];
    const members = h(
      "div",
      { class: "boxed-list" },
      t.members.map((m) =>
        h(
          "div",
          { class: "item" },
          avatar(m.name || m.id, m.id),
          h(
            "div",
            { class: "grow" },
            h(
              "div",
              { class: "strong" },
              m.name || m.id,
              m.id === me ? " (you)" : "",
            ),
            h("div", { class: "dim small mono" }, m.id),
          ),
          tag(m.role, m.role === "admin" ? "accent" : ""),
          admin &&
            h(
              "button",
              {
                class: "flat small",
                disabled: busy || (m.role === "admin" && admins <= 1),
                title:
                  m.role === "admin" && admins <= 1
                    ? "The last admin cannot be removed"
                    : "",
                onclick: async () => {
                  if (
                    await ctx.confirm(
                      `Remove ${m.name || m.id}?`,
                      `${m.name || m.id} loses access to the rooms of ${t.name} and their team grants stop working.`,
                      "Remove",
                      true,
                    )
                  )
                    void act(ctx, "Member removed.", () =>
                      api(
                        "DELETE",
                        `/owner/teams/${seg(t.id)}/members/${seg(m.id)}`,
                      ),
                    );
                },
              },
              "Remove",
            ),
        ),
      ),
      invites.map((i) =>
        h(
          "div",
          { class: "item" },
          avatar(i.name, i.name, { ghost: true }),
          h(
            "div",
            { class: "grow" },
            h("div", { class: "dim strong" }, i.name),
            h(
              "div",
              { class: "dim small" },
              i.note || "No account or agents yet",
            ),
          ),
          tag("invited"),
          admin &&
            h(
              "button",
              {
                class: "flat small",
                disabled: busy,
                onclick: async () => {
                  if (
                    await ctx.confirm(
                      `Withdraw the invite for ${i.name}?`,
                      "The placeholder is removed from the team.",
                      "Withdraw",
                      true,
                    )
                  )
                    void act(ctx, "Invite withdrawn.", () =>
                      api(
                        "DELETE",
                        `/owner/teams/${seg(t.id)}/invites/${seg(i.id)}`,
                      ),
                    );
                },
              },
              "Withdraw",
            ),
        ),
      ),
    );

    let addForm: HTMLElement | false = false;
    if (admin) {
      const owner = h("input", {
        placeholder: "username (owner id)",
        style: "flex:1;min-width:160px",
      });
      const role = h(
        "select",
        null,
        h("option", { value: "member" }, "member"),
        h("option", { value: "admin" }, "admin"),
      );
      const invName = h("input", {
        placeholder: "display name",
        style: "flex:1;min-width:140px",
      });
      const invNote = h("input", {
        placeholder: "note (optional)",
        style: "flex:1;min-width:140px",
      });
      addForm = h(
        "div",
        { class: "card" },
        h("div", { class: "strong" }, "Add a member"),
        h(
          "div",
          { class: "row" },
          owner,
          role,
          h(
            "button",
            {
              class: "suggested",
              disabled: busy,
              onclick: () => {
                const id = owner.value.trim();
                if (!id) return;
                if (id.includes("@"))
                  return ctx.toast(
                    "Use the username (owner id), not an email.",
                  );
                void act(ctx, `${id} added.`, () =>
                  api("POST", `/owner/teams/${seg(t.id)}/members`, {
                    body: { owner: id, role: role.value },
                  }),
                );
              },
            },
            "Add",
          ),
        ),
        h(
          "div",
          { class: "strong", style: "margin-top:6px" },
          "Invite someone without an account",
        ),
        h(
          "div",
          { class: "row" },
          invName,
          invNote,
          h(
            "button",
            {
              disabled: busy,
              onclick: () => {
                const name = invName.value.trim();
                if (!name) return;
                const note = invNote.value.trim();
                void act(ctx, `${name} invited.`, () =>
                  api("POST", `/owner/teams/${seg(t.id)}/invites`, {
                    body: note ? { name, note } : { name },
                  }),
                );
              },
            },
            "Invite",
          ),
        ),
      );
    }

    const rooms = h(
      "div",
      { class: "boxed-list" },
      t.rooms.length === 0 &&
        h("div", { class: "item dim" }, "No rooms in this team yet."),
      t.rooms.map((r) => {
        const info = roomsCache.find((x) => x.room === r);
        return h(
          "div",
          {
            class: "item clickable",
            onclick: () => ctx.nav("rooms", { room: r }),
          },
          h("span", null, "#"),
          h(
            "div",
            { class: "grow" },
            h("div", { class: "strong" }, info?.title || r),
            info && h("div", { class: "dim small" }, `${info.threads} threads`),
          ),
          info && info.unread > 0 && tag(`${info.unread} unread`, "accent"),
        );
      }),
    );

    replace(
      el,
      error && h("div", { class: "banner error" }, error),
      teams.length > 1 &&
        h(
          "div",
          { class: "toolbar" },
          h("span", { class: "dim small" }, "Team"),
          h(
            "select",
            {
              onchange: (e: Event) =>
                ctx.setTeam((e.target as HTMLSelectElement).value),
            },
            teams.map((x) =>
              h("option", { value: x.id, selected: x.id === t.id }, x.name),
            ),
          ),
        ),
      header,
      !admin &&
        h(
          "div",
          { class: "dim small" },
          t.role === "admin"
            ? "Read-only token: team changes are disabled."
            : "Only team admins change members, invites and the gate.",
        ),
      gate,
      h(
        "div",
        { class: "section-title" },
        "Members",
        h("span", { class: "n" }, String(t.members.length + invites.length)),
      ),
      members,
      addForm,
      h(
        "div",
        { class: "section-title" },
        "Rooms",
        h("span", { class: "n" }, String(t.rooms.length)),
      ),
      rooms,
    );
  }

  const view: View = {
    title: "Team",
    el,
    update(ctx: Ctx, ch: Changes) {
      if (!loaded || ch.feed) {
        loadTeams()
          .then(() => {
            loaded = true;
            error = "";
          })
          .catch((e) => {
            loaded = true;
            error = errorText(e);
          })
          .finally(() => draw(ctx));
        if (loaded) draw(ctx);
        else draw(ctx);
        return;
      }
      if (!ch.any) draw(ctx);
    },
  };
  return view;
}
