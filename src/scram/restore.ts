import { CloudflareApi } from "../cf/api.js";
import { readConfig } from "../config.js";
import { notify } from "../notify.js";
import { undoAll } from "./execute.js";
import { resolveAccount } from "./check.js";
import * as db from "../db/queries.js";
import type { ActionResult, Env, Target } from "../types.js";

export interface RestoreResult {
  readonly tripId: number;
  readonly results: readonly ActionResult[];
  readonly restored: number;
  readonly failed: number;
}

/**
 * Put back exactly what the last trip took away.
 *
 * Replays `trips.snapshot`, which was written before anything was disabled.
 * Targets that fail are reported rather than retried: if a route cannot be
 * recreated, that needs a human, and silently looping would hide it.
 */
export async function restore(env: Env, tripId?: number): Promise<RestoreResult> {
  const config = readConfig(env);
  const api = new CloudflareApi(env.CF_API_TOKEN);
  const accountId = await resolveAccount(api, config);

  const trip = tripId
    ? await env.DB.prepare(`SELECT * FROM trips WHERE id = ?`).bind(tripId).first<db.TripRow>()
    : await db.activeTrip(env.DB);

  if (!trip) throw new Error("no trip to restore");
  if (trip.restored_at) throw new Error(`trip ${trip.id} was already restored at ${trip.restored_at}`);

  const targets = JSON.parse(trip.snapshot) as Target[];
  const results = await undoAll(api, accountId, targets, false);
  await db.recordActions(env.DB, trip.id, "undo", results);

  const restored = results.filter((r) => r.status === "ok").length;
  const failed = results.filter((r) => r.status === "failed").length;

  // Only close the trip out when everything came back. A partial restore stays
  // open so it keeps showing on the status page as unfinished business.
  if (failed === 0) await db.markRestored(env.DB, trip.id);

  await notify(config, {
    kind: "restore",
    title: failed === 0 ? "Restored" : "Restored with failures",
    message: `Trip ${trip.id}: ${restored} of ${targets.length} targets restored` +
      (failed ? `, ${failed} failed and the trip stays open.` : "."),
    detail: results.filter((r) => r.status === "failed").map((r) => `${r.target.label}: ${r.error}`),
  });

  return { tripId: trip.id, results, restored, failed };
}
