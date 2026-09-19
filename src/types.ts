/** usage[productId][meterId] = raw observed number for the billing cycle. */
export type UsageMap = Record<string, Record<string, number>>;

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  CF_API_TOKEN: string;
  ADMIN_TOKEN: string;
  NOTIFY_WEBHOOK?: string;

  CF_ACCOUNT_ID?: string;
  WARN_AT_USD: string;
  SCRAM_AT_USD: string;
  BILLING_CYCLE_DAY: string;
  ARMED: string;
  PROTECT?: string;
  ACTIONS: string;
}

export type ActionKind = "routes" | "custom_domains" | "crons" | "subdomain";

export interface Config {
  readonly accountId: string | null;
  readonly warnAtUsd: number;
  readonly scramAtUsd: number;
  readonly billingCycleDay: number;
  readonly armed: boolean;
  /** Script names that must never be touched. Always includes scram itself. */
  readonly protect: ReadonlySet<string>;
  readonly actions: readonly ActionKind[];
  readonly notifyWebhook: string | null;
}

/** One reversible thing scram can switch off. */
export interface Target {
  readonly kind: ActionKind;
  /** The Worker script this belongs to, for protection checks and reporting. */
  readonly script: string;
  /** Human-readable target: a route pattern, a hostname, or a cron line. */
  readonly label: string;
  /** Everything needed to undo this, serialised into the trip snapshot. */
  readonly undo: Record<string, unknown>;
  /** Everything needed to do it. */
  readonly apply: Record<string, unknown>;
}

export interface ActionResult {
  readonly target: Target;
  readonly status: "ok" | "failed" | "skipped";
  readonly error?: string;
}

export interface Reading {
  readonly observedAt: string;
  readonly cycleStart: string;
  readonly totalUsd: number;
  readonly armed: boolean;
}
