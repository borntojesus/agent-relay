// Bridge to the Rust core. The UI never holds the token: every request goes
// through the `api` command, which adds the bearer and X-Relay-Owner itself.

import { invoke } from "@tauri-apps/api/core";
import type { AppView } from "./types.ts";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
  /** Human text, same wording as the Mac app. */
  get text(): string {
    switch (this.status) {
      case 0:
        return this.message;
      case 401:
        return `Unauthorized: ${this.message}`;
      case 403:
        return `Forbidden: ${this.message}`;
      case 404:
        return `Not found: ${this.message}`;
      case 409:
        return `Already decided: ${this.message}`;
      default:
        return `HTTP ${this.status}: ${this.message}`;
    }
  }
}

export const seg = (s: string | number): string =>
  encodeURIComponent(String(s));

type Query = Record<string, string | number | boolean | undefined | null>;

export async function api<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  opts: { query?: Query; body?: unknown } = {},
): Promise<T> {
  const query: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== false)
      query.push([k, String(v)]);
  }
  try {
    return await invoke<T>("api", {
      method,
      path,
      query,
      body: opts.body ?? null,
    });
  } catch (e) {
    const err = e as { status?: number; message?: string };
    throw new ApiError(err?.status ?? 0, err?.message ?? String(e));
  }
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.text;
  if (e && typeof e === "object" && "message" in e)
    return String((e as { message: unknown }).message);
  return String(e);
}

export const core = {
  state: () => invoke<AppView>("get_state"),
  signIn: (
    server: string,
    username: string,
    token: string,
    sessionOnly = false,
  ) => invoke<AppView>("sign_in", { server, username, token, sessionOnly }),
  signOut: () => invoke<void>("sign_out"),
  refresh: () => invoke<void>("refresh"),
  saveSettings: (s: {
    pollSeconds: number;
    notifications: boolean;
    tray: boolean;
    team: string;
  }) => invoke<AppView>("save_settings", s),
  quit: () => invoke<void>("quit"),
};
