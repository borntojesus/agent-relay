import type { DeviceStore } from "./devices.ts";
import type {
  OnPending,
  PendingItem,
  PushMessage,
  PushSender,
} from "./types.ts";

const TEXT: Record<PendingItem["kind"], { title: string; body: string }> = {
  post: { title: "Post waiting", body: "Post waiting for your tap" },
  approval: {
    title: "Approval waiting",
    body: "An action is waiting for your decision",
  },
  task: { title: "Task waiting", body: "A task is waiting for your start" },
  tool: { title: "Approval waiting", body: "A task wants to run a tool" },
};

export function messageFor(item: PendingItem): PushMessage {
  const t = TEXT[item.kind];
  return {
    kind: item.kind,
    id: String(item.id),
    ...(item.room ? { room: item.room } : {}),
    title: t.title,
    body: t.body,
    actionable: item.kind !== "task",
  };
}

/** Fans a pending item out to the owner's devices. Fire and forget: nothing here throws. */
export function createDispatcher(
  devices: DeviceStore,
  senders: PushSender[],
  log?: (line: string) => void,
): OnPending {
  const byPlatform = new Map(senders.map((s) => [s.platform, s]));
  return (owner, item) => {
    if (byPlatform.size === 0) return;
    try {
      const msg = messageFor(item);
      for (const d of devices.list(owner)) {
        const sender = byPlatform.get(d.platform);
        if (!sender) continue;
        void sender
          .send({ token: d.token, environment: d.environment, app: d.app }, msg)
          .then((r) => {
            if (r === "dead") {
              devices.remove(d.token);
              log?.(`[push] ${d.platform} device of ${owner} is gone; removed`);
            }
          })
          .catch((err: unknown) =>
            log?.(
              `[push] ${d.platform} send for ${owner} failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      }
    } catch (err) {
      log?.(
        `[push] dispatch for ${owner} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
}
