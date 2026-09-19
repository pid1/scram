import type { Config } from "./types.js";

export type NotifyKind = "warn" | "trip" | "restore" | "error";

export interface Notification {
  readonly kind: NotifyKind;
  readonly title: string;
  readonly message: string;
  readonly totalUsd?: number;
  readonly thresholdUsd?: number;
  readonly detail?: unknown;
}

/**
 * Best-effort outbound notice.
 *
 * Deliberately never throws: a webhook that is down must not stop a trip from
 * being carried out. The whole point is that the account gets shut off whether
 * or not anyone is told about it.
 */
export async function notify(config: Config, n: Notification): Promise<void> {
  const line = `[scram:${n.kind}] ${n.title} -- ${n.message}`;
  if (n.kind === "error") console.error(line);
  else console.log(line);

  if (!config.notifyWebhook) return;

  try {
    await fetch(config.notifyWebhook, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // ntfy reads these; other receivers ignore them.
        Title: n.title,
        Priority: n.kind === "trip" ? "urgent" : n.kind === "error" ? "high" : "default",
        Tags: n.kind === "trip" ? "rotating_light" : "money_with_wings",
      },
      body: JSON.stringify({
        kind: n.kind,
        title: n.title,
        // `text` and `content` cover ntfy, Slack and Discord shapes without
        // needing a per-service adapter.
        text: n.message,
        content: n.message,
        message: n.message,
        total_usd: n.totalUsd,
        threshold_usd: n.thresholdUsd,
        detail: n.detail,
        at: new Date().toISOString(),
      }),
    });
  } catch (e) {
    console.error(`[scram:notify] webhook failed: ${String((e as Error)?.message ?? e)}`);
  }
}
