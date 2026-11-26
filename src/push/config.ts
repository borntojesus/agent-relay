import { ApnsSender } from "./apns.ts";
import { FcmSender } from "./fcm.ts";
import type { PushSender } from "./types.ts";

/** Senders switched on by the environment; each is off unless fully configured. */
export function pushSendersFromEnv(
  env: NodeJS.ProcessEnv,
  log?: (line: string) => void,
): PushSender[] {
  const out: PushSender[] = [];
  const {
    RELAY_APNS_KEY_FILE: keyFile,
    RELAY_APNS_KEY_ID: keyId,
    RELAY_APNS_TEAM_ID: teamId,
    RELAY_APNS_TOPIC: topic,
  } = env;
  if (keyFile && keyId && teamId && topic) {
    try {
      out.push(new ApnsSender({ keyFile, keyId, teamId, topic }));
      log?.("[push] APNs on");
    } catch (err) {
      log?.(
        `[push] APNs off: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (keyFile || keyId || teamId || topic) {
    log?.(
      "[push] APNs off: RELAY_APNS_KEY_FILE, _KEY_ID, _TEAM_ID and _TOPIC are all needed",
    );
  }
  if (env.RELAY_FCM_SERVICE_ACCOUNT_FILE) {
    try {
      out.push(new FcmSender(env.RELAY_FCM_SERVICE_ACCOUNT_FILE));
      log?.("[push] FCM on");
    } catch (err) {
      log?.(
        `[push] FCM off: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}
