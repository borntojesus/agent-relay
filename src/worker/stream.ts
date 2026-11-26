/**
 * Parser for `claude -p --output-format stream-json --verbose`: one JSON
 * object per line. Unknown or broken lines are ignored (the stream is the
 * child's output, not trusted to be well-formed).
 */

export interface StreamInit {
  sessionId: string;
  claudeVersion?: string;
  cwd?: string;
}

export interface StreamResult {
  isError: boolean;
  subtype?: string;
  result?: string;
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
  sessionId?: string;
}

export interface StreamHandlers {
  onInit?: (init: StreamInit) => void;
  onText?: (text: string) => void;
  onToolUse?: (id: string, name: string, input: unknown) => void;
  onToolResult?: (id: string, name: string, ok: boolean) => void;
  onResult?: (result: StreamResult) => void;
}

/** Longest line kept in the buffer; a longer one is dropped. */
const MAX_LINE = 4 * 1024 * 1024;

export class StreamParser {
  #buf = "";
  #dropping = false;
  #h: StreamHandlers;
  #toolNames = new Map<string, string>();

  constructor(handlers: StreamHandlers) {
    this.#h = handlers;
  }

  push(chunk: string): void {
    this.#buf += chunk;
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      if (this.#dropping) {
        this.#dropping = false;
        continue;
      }
      this.#line(line);
    }
    if (this.#buf.length > MAX_LINE) {
      this.#buf = "";
      this.#dropping = true;
    }
  }

  end(): void {
    if (this.#buf && !this.#dropping) this.#line(this.#buf);
    this.#buf = "";
  }

  #line(line: string): void {
    const t = line.trim();
    if (!t.startsWith("{")) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(t) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init" && typeof msg.session_id === "string") {
          this.#h.onInit?.({
            sessionId: msg.session_id,
            ...(typeof msg.claude_code_version === "string"
              ? { claudeVersion: msg.claude_code_version }
              : {}),
            ...(typeof msg.cwd === "string" ? { cwd: msg.cwd } : {}),
          });
        }
        return;
      case "assistant":
        for (const block of contentOf(msg)) {
          if (
            block.type === "text" &&
            typeof block.text === "string" &&
            block.text.trim()
          ) {
            this.#h.onText?.(block.text);
          } else if (
            block.type === "tool_use" &&
            typeof block.name === "string"
          ) {
            const id = typeof block.id === "string" ? block.id : "";
            if (id) this.#toolNames.set(id, block.name);
            this.#h.onToolUse?.(id, block.name, block.input);
          }
        }
        return;
      case "user":
        for (const block of contentOf(msg)) {
          if (block.type === "tool_result") {
            const id =
              typeof block.tool_use_id === "string" ? block.tool_use_id : "";
            const name = this.#toolNames.get(id) ?? "unknown";
            this.#toolNames.delete(id);
            this.#h.onToolResult?.(id, name, block.is_error !== true);
          }
        }
        return;
      case "result":
        this.#h.onResult?.({
          isError:
            msg.is_error === true ||
            (typeof msg.subtype === "string" && msg.subtype !== "success"),
          ...(typeof msg.subtype === "string" ? { subtype: msg.subtype } : {}),
          ...(typeof msg.result === "string" ? { result: msg.result } : {}),
          ...(typeof msg.total_cost_usd === "number"
            ? { costUsd: msg.total_cost_usd }
            : {}),
          ...(typeof msg.num_turns === "number"
            ? { numTurns: msg.num_turns }
            : {}),
          ...(typeof msg.duration_ms === "number"
            ? { durationMs: msg.duration_ms }
            : {}),
          ...(typeof msg.session_id === "string"
            ? { sessionId: msg.session_id }
            : {}),
        });
        return;
      default:
        return;
    }
  }
}

function contentOf(
  msg: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const m = msg.message as { content?: unknown } | undefined;
  if (!m || !Array.isArray(m.content)) return [];
  return m.content.filter(
    (b): b is Record<string, unknown> => !!b && typeof b === "object",
  );
}
