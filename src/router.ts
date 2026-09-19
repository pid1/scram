import { check } from "./scram/check.js";
import { restore } from "./scram/restore.js";
import { readConfig } from "./config.js";
import { CloudflareApi } from "./cf/api.js";
import { discover } from "./cf/discover.js";
import { resolveAccount } from "./scram/check.js";
import { RATES_VERIFIED_ON } from "./pricing/catalog.js";
import { authorised, error, json } from "./http/responses.js";
import * as db from "./db/queries.js";
import type { Env } from "./types.js";

export async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/healthcheck") return new Response("ok\n", { status: 200 });

  // Everything under /api needs the admin token. The status page fetches it
  // with a token the operator pastes in; there is no unauthenticated read,
  // because the breakdown is a map of what the account runs and what it costs.
  if (path.startsWith("/api")) {
    if (!authorised(req, env.ADMIN_TOKEN)) return error("unauthorized", 401);

    try {
      switch (`${req.method} ${path}`) {
        case "GET /api/status":
          return json(await status(env));

        case "POST /api/check":
          return json(await check(env));

        case "POST /api/scram": {
          // Manual trip. Runs the real shutdown regardless of the dollar
          // estimate, but still honours ARMED so a dry-run deploy stays a
          // dry run.
          const config = readConfig(env);
          const api = new CloudflareApi(env.CF_API_TOKEN);
          const accountId = await resolveAccount(api, config);
          const inventory = await discover(api, accountId, config);
          const { applyAll } = await import("./scram/execute.js");
          const tripId = await db.openTrip(
            env.DB,
            "manual trip via /api/scram",
            0,
            config.scramAtUsd,
            !config.armed,
            inventory.targets,
          );
          const results = await applyAll(api, accountId, inventory.targets, !config.armed);
          await db.recordActions(env.DB, tripId, "apply", results);
          return json({ tripId, dryRun: !config.armed, results });
        }

        case "POST /api/restore": {
          const body = (await req.json().catch(() => ({}))) as { tripId?: number };
          return json(await restore(env, body.tripId));
        }

        case "GET /api/preview": {
          // What a trip would touch right now, without touching it.
          const config = readConfig(env);
          const api = new CloudflareApi(env.CF_API_TOKEN);
          const accountId = await resolveAccount(api, config);
          return json(await discover(api, accountId, config));
        }

        default:
          return error("not found", 404);
      }
    } catch (e) {
      return error(String((e as Error)?.message ?? e), 500);
    }
  }

  // Everything else is the static status page.
  return env.ASSETS.fetch(req);
}

async function status(env: Env) {
  const config = readConfig(env);
  const [latest, active, readings] = await Promise.all([
    env.DB.prepare(
      `SELECT observed_at, cycle_start, total_usd, armed, breakdown, failures
       FROM readings ORDER BY observed_at DESC LIMIT 1`,
    ).first<{
      observed_at: string;
      cycle_start: string;
      total_usd: number;
      armed: number;
      breakdown: string;
      failures: string;
    }>(),
    db.activeTrip(env.DB),
    db.recentReadings(env.DB, 96),
  ]);

  return {
    armed: config.armed,
    warnAtUsd: config.warnAtUsd,
    scramAtUsd: config.scramAtUsd,
    billingCycleDay: config.billingCycleDay,
    actions: config.actions,
    protect: [...config.protect],
    ratesVerifiedOn: RATES_VERIFIED_ON,
    latest: latest
      ? {
          observedAt: latest.observed_at,
          cycleStart: latest.cycle_start,
          totalUsd: latest.total_usd,
          armed: latest.armed === 1,
          lines: JSON.parse(latest.breakdown),
          failures: JSON.parse(latest.failures),
        }
      : null,
    activeTrip: active
      ? {
          id: active.id,
          trippedAt: active.tripped_at,
          reason: active.reason,
          totalUsd: active.total_usd,
        }
      : null,
    history: (readings.results ?? []).map((x) => ({
      at: x.observed_at,
      usd: x.total_usd,
    })),
  };
}
