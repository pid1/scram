-- One row per check. This is the audit trail: what scram believed the account
-- was costing, when, and whether it was armed at the time.
CREATE TABLE readings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at  TEXT    NOT NULL,
  cycle_start  TEXT    NOT NULL,
  total_usd    REAL    NOT NULL,
  armed        INTEGER NOT NULL,
  -- JSON: the full per-meter breakdown, so a past reading can be re-read
  -- against a later version of the price list.
  breakdown    TEXT    NOT NULL,
  -- JSON: products whose collector failed on this run. Empty object is clean.
  failures     TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX readings_observed_at ON readings (observed_at DESC);

-- One row per trip. `snapshot` is the complete set of targets as they were
-- BEFORE anything was disabled, and is what /api/restore replays.
CREATE TABLE trips (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tripped_at    TEXT    NOT NULL,
  reason        TEXT    NOT NULL,
  total_usd     REAL    NOT NULL,
  threshold_usd REAL    NOT NULL,
  dry_run       INTEGER NOT NULL,
  snapshot      TEXT    NOT NULL,
  restored_at   TEXT
);

CREATE INDEX trips_tripped_at ON trips (tripped_at DESC);

-- One row per individual operation attempted during a trip or a restore, so a
-- partial shutdown is legible after the fact.
CREATE TABLE actions (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id  INTEGER NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
  phase    TEXT    NOT NULL CHECK (phase IN ('apply', 'undo')),
  kind     TEXT    NOT NULL,
  script   TEXT    NOT NULL,
  label    TEXT    NOT NULL,
  status   TEXT    NOT NULL CHECK (status IN ('ok', 'failed', 'skipped')),
  error    TEXT,
  at       TEXT    NOT NULL
);

CREATE INDEX actions_trip_id ON actions (trip_id);
