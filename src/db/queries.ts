import type { ActionResult, Target } from "../types.js";
import type { Estimate } from "../pricing/estimate.js";

export interface TripRow {
  id: number;
  tripped_at: string;
  reason: string;
  total_usd: number;
  threshold_usd: number;
  dry_run: number;
  snapshot: string;
  restored_at: string | null;
}

export async function recordReading(
  db: D1Database,
  observedAt: string,
  cycleStart: string,
  est: Estimate,
  armed: boolean,
  failures: Record<string, string>,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO readings (observed_at, cycle_start, total_usd, armed, breakdown, failures)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      observedAt,
      cycleStart,
      est.totalUsd,
      armed ? 1 : 0,
      JSON.stringify(est.lines),
      JSON.stringify(failures),
    )
    .run();
}

export async function openTrip(
  db: D1Database,
  reason: string,
  totalUsd: number,
  thresholdUsd: number,
  dryRun: boolean,
  snapshot: readonly Target[],
): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO trips (tripped_at, reason, total_usd, threshold_usd, dry_run, snapshot)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      new Date().toISOString(),
      reason,
      totalUsd,
      thresholdUsd,
      dryRun ? 1 : 0,
      JSON.stringify(snapshot),
    )
    .first<{ id: number }>();
  if (!res) throw new Error("failed to open trip record");
  return res.id;
}

export async function recordActions(
  db: D1Database,
  tripId: number,
  phase: "apply" | "undo",
  results: readonly ActionResult[],
): Promise<void> {
  if (results.length === 0) return;
  const at = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO actions (trip_id, phase, kind, script, label, status, error, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await db.batch(
    results.map((r) =>
      stmt.bind(
        tripId,
        phase,
        r.target.kind,
        r.target.script,
        r.target.label,
        r.status,
        r.error ?? null,
        at,
      ),
    ),
  );
}

/** The most recent trip that has not been restored, if any. */
export function activeTrip(db: D1Database): Promise<TripRow | null> {
  return db
    .prepare(
      `SELECT * FROM trips WHERE restored_at IS NULL AND dry_run = 0
       ORDER BY tripped_at DESC LIMIT 1`,
    )
    .first<TripRow>();
}

export function latestTrip(db: D1Database): Promise<TripRow | null> {
  return db.prepare(`SELECT * FROM trips ORDER BY tripped_at DESC LIMIT 1`).first<TripRow>();
}

export async function markRestored(db: D1Database, tripId: number): Promise<void> {
  await db
    .prepare(`UPDATE trips SET restored_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), tripId)
    .run();
}

export function recentReadings(db: D1Database, limit = 96) {
  return db
    .prepare(
      `SELECT observed_at, total_usd, armed FROM readings
       ORDER BY observed_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<{ observed_at: string; total_usd: number; armed: number }>();
}
