import { CloudflareApi } from "../cf/api.js";
import { discover, type Inventory } from "../cf/discover.js";
import { readConfig, cycleStart } from "../config.js";
import { estimate, type Estimate } from "../pricing/estimate.js";
import { collectAll } from "../usage/collect.js";
import { GraphQLClient, range } from "../usage/graphql.js";
import { notify } from "../notify.js";
import { applyAll } from "./execute.js";
import * as db from "../db/queries.js";
import type { Config, Env } from "../types.js";

export interface CheckResult {
  readonly at: string;
  readonly cycleStart: string;
  readonly accountId: string;
  readonly estimate: Estimate;
  readonly failures: Readonly<Record<string, string>>;
  readonly armed: boolean;
  readonly warnAtUsd: number;
  readonly scramAtUsd: number;
  readonly action: "none" | "warned" | "tripped" | "blind";
  readonly inventory?: Inventory;
  readonly tripId?: number;
}

/** Resolve the account without hardcoding it, and refuse to guess. */
export async function resolveAccount(api: CloudflareApi, config: Config): Promise<string> {
  if (config.accountId) return config.accountId;
  const accounts = await api.get<{ id: string; name: string }[]>("/accounts");
  if (accounts.length === 1) return accounts[0]!.id;
  throw new Error(
    `token can see ${accounts.length} accounts; set CF_ACCOUNT_ID to the one to watch`,
  );
}

export async function check(env: Env, now = new Date()): Promise<CheckResult> {
  const config = readConfig(env);
  const api = new CloudflareApi(env.CF_API_TOKEN);
  const accountId = await resolveAccount(api, config);

  const start = cycleStart(now, config.billingCycleDay);
  const r = range(start, now);
  const gql = new GraphQLClient(env.CF_API_TOKEN, accountId);

  const collected = await collectAll(gql, r);
  const est = estimate(collected.usage);
  const at = now.toISOString();

  await db.recordReading(
    env.DB,
    at,
    start.toISOString(),
    est,
    config.armed,
    collected.failures,
  );

  const base = {
    at,
    cycleStart: start.toISOString(),
    accountId,
    estimate: est,
    failures: collected.failures,
    armed: config.armed,
    warnAtUsd: config.warnAtUsd,
    scramAtUsd: config.scramAtUsd,
  };

  // Every collector failed. The estimate is $0 only because scram is blind,
  // and $0 must never be read as "safe" in that state.
  if (!collected.anySucceeded) {
    await notify(config, {
      kind: "error",
      title: "scram is blind",
      message:
        "Every usage collector failed, so spend cannot be estimated. " +
        "Check CF_API_TOKEN and its Analytics scope.",
      detail: collected.failures,
    });
    return { ...base, action: "blind" };
  }

  if (est.totalUsd >= config.scramAtUsd) {
    return await trip(env, config, api, accountId, est, base);
  }

  // Warn on the crossing, not on every tick, or a 15-minute cron would send
  // 96 identical notices a day.
  if (est.totalUsd >= config.warnAtUsd) {
    const previous = await db.recentReadings(env.DB, 2);
    const prior = previous.results?.[1]?.total_usd;
    if (prior === undefined || prior < config.warnAtUsd) {
      await notify(config, {
        kind: "warn",
        title: `Estimated spend $${est.totalUsd.toFixed(2)}`,
        message:
          `Usage-based spend this cycle has passed the $${config.warnAtUsd} warning ` +
          `line. scram trips at $${config.scramAtUsd}.`,
        totalUsd: est.totalUsd,
        thresholdUsd: config.warnAtUsd,
        detail: est.byProduct,
      });
      return { ...base, action: "warned" };
    }
  }

  return { ...base, action: "none" };
}

async function trip(
  env: Env,
  config: Config,
  api: CloudflareApi,
  accountId: string,
  est: Estimate,
  base: Omit<CheckResult, "action">,
): Promise<CheckResult> {
  const inventory = await discover(api, accountId, config);

  // Already tripped and nothing new has appeared since. Staying quiet here is
  // what stops a tripped account from re-notifying every 15 minutes.
  const active = await db.activeTrip(env.DB);
  if (active && inventory.targets.length === 0) {
    return { ...base, action: "tripped", inventory, tripId: active.id };
  }

  const dryRun = !config.armed;
  const tripId = await db.openTrip(
    env.DB,
    `estimated $${est.totalUsd.toFixed(2)} >= threshold $${config.scramAtUsd}`,
    est.totalUsd,
    config.scramAtUsd,
    dryRun,
    inventory.targets,
  );

  const results = await applyAll(api, accountId, inventory.targets, dryRun);
  await db.recordActions(env.DB, tripId, "apply", results);

  const ok = results.filter((x) => x.status === "ok").length;
  const failed = results.filter((x) => x.status === "failed");

  await notify(config, {
    kind: dryRun ? "warn" : "trip",
    title: dryRun
      ? `DRY RUN: would have scrammed at $${est.totalUsd.toFixed(2)}`
      : `SCRAMMED at $${est.totalUsd.toFixed(2)}`,
    message: dryRun
      ? `ARMED is 0, so nothing was changed. ${inventory.targets.length} targets ` +
        `would have been disabled across ${new Set(inventory.targets.map((t) => t.script)).size} Workers.`
      : `Disabled ${ok} of ${inventory.targets.length} targets. ` +
        (failed.length ? `${failed.length} failed. ` : "") +
        `Restore with POST /api/restore.`,
    totalUsd: est.totalUsd,
    thresholdUsd: config.scramAtUsd,
    detail: {
      byProduct: est.byProduct,
      targets: inventory.targets.map((t) => `${t.kind}:${t.script}:${t.label}`),
      failures: failed.map((f) => `${f.target.label}: ${f.error}`),
      discoveryFailures: inventory.failures,
    },
  });

  return { ...base, action: "tripped", inventory, tripId };
}
