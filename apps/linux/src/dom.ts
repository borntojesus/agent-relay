// Tiny DOM helper. Strings always become text nodes: agent text is untrusted
// and is never parsed as HTML (no innerHTML anywhere in the UI).

export type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & {
  class?: string | false | null;
  style?: string;
};

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === "class") {
        el.className = String(v);
      } else if (
        k === "value" ||
        k === "checked" ||
        k === "disabled" ||
        k === "selected"
      ) {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else if (v === true) {
        el.setAttribute(k, "");
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function replace(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

// ------------------------------------------------------------------ format

const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const fullFmt = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

export function when(s: string | null | undefined): string {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? timeFmt.format(d)
    : dateTimeFmt.format(d);
}

export function stamp(s: string | null | undefined): string {
  if (!s) return "";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : fullFmt.format(d);
}

export function countdown(s: string, now = Date.now()): string {
  const t = new Date(s).getTime();
  if (Number.isNaN(t)) return s;
  const left = Math.floor((t - now) / 1000);
  if (left <= 0) return "expired";
  const hh = Math.floor(left / 3600);
  const mm = Math.floor((left % 3600) / 60);
  const ss = left % 60;
  return hh > 0
    ? `${hh}h ${String(mm).padStart(2, "0")}m left`
    : `${mm}:${String(ss).padStart(2, "0")} left`;
}

// ------------------------------------------------------------------ avatars

const PALETTE = [
  "#3584e4",
  "#2ec27e",
  "#e66100",
  "#9141ac",
  "#c64600",
  "#1c71d8",
  "#26a269",
  "#865e3c",
  "#e01b24",
  "#5e5c64",
];

export function initials(name: string): string {
  const parts = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function colour(key: string): string {
  let x = 0;
  for (const ch of key) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[x % PALETTE.length];
}

export function avatar(
  name: string,
  key = name,
  opts: { small?: boolean; ghost?: boolean } = {},
): HTMLElement {
  const cls = ["avatar", opts.small ? "sm" : "", opts.ghost ? "ghost" : ""]
    .filter(Boolean)
    .join(" ");
  return h(
    "span",
    { class: cls, style: `background:${colour(key)}`, title: name },
    initials(name),
  );
}

export function tag(
  text: string,
  kind: "" | "warn" | "danger" | "accent" | "ok" = "",
): HTMLElement {
  return h("span", { class: `tag ${kind}` }, text);
}
