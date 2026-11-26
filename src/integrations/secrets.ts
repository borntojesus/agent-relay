import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Integration secrets at rest: AES-256-GCM with a key from `RELAY_SECRET_KEY`
 * (32 bytes as base64 or hex). Stored as `v1:<iv>:<tag>:<ciphertext>`, each
 * part base64. The plaintext never leaves this module except to the client
 * that calls the external service.
 */

export class SecretKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretKeyError";
  }
}

/** Parses `RELAY_SECRET_KEY`: 64 hex characters or base64 of exactly 32 bytes. */
export function parseSecretKey(raw: string): Buffer {
  const v = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, "hex");
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) {
    const b = Buffer.from(v.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (b.length === 32) return b;
  }
  throw new SecretKeyError(
    "RELAY_SECRET_KEY must be 32 bytes, as 64 hex characters or base64",
  );
}

export class SecretBox {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32)
      throw new SecretKeyError("the secret key is 32 bytes");
    this.key = key;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return [
      "v1",
      iv.toString("base64"),
      c.getAuthTag().toString("base64"),
      ct.toString("base64"),
    ].join(":");
  }

  /** Throws SecretKeyError when the value was sealed with another key or is damaged. */
  decrypt(sealed: string): string {
    const [v, iv, tag, ct] = sealed.split(":");
    if (v !== "v1" || !iv || !tag || ct === undefined)
      throw new SecretKeyError("unknown secret format");
    try {
      const d = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(iv, "base64"),
      );
      d.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([
        d.update(Buffer.from(ct, "base64")),
        d.final(),
      ]).toString("utf8");
    } catch {
      throw new SecretKeyError(
        "the secret cannot be decrypted (RELAY_SECRET_KEY changed?)",
      );
    }
  }
}
