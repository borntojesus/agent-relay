import type { IncomingMessage, ServerResponse } from "node:http";

export const BODY_MAX = 256 * 1024;

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  type = "application/json",
): void {
  const text =
    type === "application/json" ? JSON.stringify(body) : String(body);
  res.writeHead(status, {
    "Content-Type": `${type}; charset=utf-8`,
    "Cache-Control": "no-store",
  });
  res.end(text);
}

export async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_MAX) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body is not JSON");
  }
}

