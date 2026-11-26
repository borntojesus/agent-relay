import { parseSecretKey } from './integrations/secrets.ts';

/** Settings from the environment. Bot tokens are per owner: RELAY_BOT_TOKEN_<OWNER>. */
export interface Config {
  db: string;
  host: string;
  port: number;
  trustProxy: boolean;
  bigProjects?: RegExp;
  botTokens: Record<string, string>;
  /** RELAY_SECRET_KEY: seals integration secrets (AES-256-GCM). */
  secretKey?: string;
}

/** `RELAY_BOT_TOKEN_<OWNER>` for an owner id: uppercased, `-` becomes `_`. */
export function botTokenVar(owner: string): string {
  return `RELAY_BOT_TOKEN_${owner.toUpperCase().replace(/-/g, '_')}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.RELAY_PORT ?? 8940);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RELAY_PORT is a port number');
  let bigProjects: RegExp | undefined;
  if (env.RELAY_BIG_PROJECTS) {
    try {
      bigProjects = new RegExp(env.RELAY_BIG_PROJECTS, 'i');
    } catch {
      throw new Error('RELAY_BIG_PROJECTS is not a valid regular expression');
    }
  }
  const secretKey = env.RELAY_SECRET_KEY?.trim() || undefined;
  if (secretKey) parseSecretKey(secretKey); // a bad key stops the boot, not the first save
  const botTokens: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('RELAY_BOT_TOKEN_') && v) botTokens[k] = v;
  }
  return {
    db: env.RELAY_DB ?? './data/relay.db',
    host: env.RELAY_HOST ?? '127.0.0.1',
    port,
    trustProxy: env.RELAY_TRUST_PROXY === '1' || env.RELAY_TRUST_PROXY === 'true',
    ...(bigProjects ? { bigProjects } : {}),
    botTokens,
    ...(secretKey ? { secretKey } : {}),
  };
}
