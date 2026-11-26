import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb } from './db.ts';
import { loadConfig } from './config.ts';
import { createRelay } from './relay.ts';
import { pushSendersFromEnv } from './push/config.ts';
import { createHttpServer } from './http/server.ts';

/** Boot the relay: database, bots, HTTP server, signal handlers. */
export async function serve(): Promise<void> {
  const config = loadConfig();
  if (config.db !== ':memory:') mkdirSync(dirname(config.db), { recursive: true });
  const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
  const relay = createRelay({
    db: openDb(config.db),
    botTokens: config.botTokens,
    pushSenders: pushSendersFromEnv(process.env, log),
    ...(config.bigProjects ? { bigProjects: config.bigProjects } : {}),
    ...(config.secretKey ? { secretKey: config.secretKey } : {}),
    log,
  });

  const expired = await relay.approvals.start();
  if (expired) log(`[relay] ${expired} approval(s) pending from before the restart expired`);
  const expiredTools = relay.tasks.boot();
  if (expiredTools) log(`[relay] ${expiredTools} tool approval(s) pending from before the restart expired`);
  relay.rooms.start();
  for (const bot of relay.bots) bot.start();

  const server = createHttpServer(relay, { trustProxy: config.trustProxy, log });
  server.on('error', (err) => {
    // E.g. the VPN address is not up yet: exit and let the supervisor retry.
    log(`[relay] cannot listen on ${config.host}:${config.port}: ${err.message}`);
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    log(`[relay] listening on http://${config.host}:${config.port} (owners with a bot: ${[...relay.channels.keys()].join(', ') || 'none'})`);
  });

  const shutdown = () => {
    log('[relay] stopping');
    for (const bot of relay.bots) bot.stop();
    relay.rooms.stop();
    relay.approvals.stop();
    relay.tasks.stop();
    server.close(() => {
      relay.db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
