import type { ActionKind, Config, Env } from "./types.js";

/** The script's own name. Must match `name` in wrangler.toml. */
export const SELF = "scram";

const ALL_ACTIONS: readonly ActionKind[] = [
  "routes",
  "custom_domains",
  "crons",
  "subdomain",
];

function num(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} is not a number: ${raw}`);
  return n;
}

function list(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function readConfig(env: Env): Config {
  const actions = list(env.ACTIONS).filter((a): a is ActionKind =>
    (ALL_ACTIONS as readonly string[]).includes(a),
  );

  const warnAtUsd = num(env.WARN_AT_USD, 5, "WARN_AT_USD");
  const scramAtUsd = num(env.SCRAM_AT_USD, 20, "SCRAM_AT_USD");
  if (scramAtUsd <= 0) throw new Error("SCRAM_AT_USD must be greater than zero");

  const day = num(env.BILLING_CYCLE_DAY, 1, "BILLING_CYCLE_DAY");
  if (day < 1 || day > 28) {
    // 29-31 would skip months. Cloudflare bills from the subscription date; if
    // yours is the 31st, set 28 and accept the estimate runs a few days long.
    throw new Error("BILLING_CYCLE_DAY must be between 1 and 28");
  }

  return {
    accountId: env.CF_ACCOUNT_ID?.trim() || null,
    warnAtUsd,
    scramAtUsd,
    billingCycleDay: day,
    armed: env.ARMED === "1",
    // Self-protection is not configurable. A scram that can disable its own
    // route cannot be restored through its own UI.
    protect: new Set([SELF, ...list(env.PROTECT)]),
    actions: actions.length > 0 ? actions : ALL_ACTIONS,
    notifyWebhook: env.NOTIFY_WEBHOOK?.trim() || null,
  };
}

/**
 * Start of the billing cycle containing `now`, as an ISO timestamp.
 *
 * Cloudflare resets monthly included usage on the subscription renewal date,
 * not the 1st, so summing from the calendar month would under-count for most
 * of the cycle and over-count right after it rolls.
 */
export function cycleStart(now: Date, day: number): Date {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day, 0, 0, 0, 0),
  );
  if (start > now) start.setUTCMonth(start.getUTCMonth() - 1);
  return start;
}
