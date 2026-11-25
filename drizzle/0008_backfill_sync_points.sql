-- Sync points for a database from before 0006, so "Sync changes" works there without a full run first. Where the old rule
-- (changes since the last successful run) is known to hold, each applied board gets that run's monday read as its point: the
-- migration is `completed` (no discover, link or dry run since: each would have changed it) and its latest apply or undo run is a
-- successful apply. A board with a point already is left alone. Not visible here: a people match or a recreateDrifted toggle since that
-- run (neither changes the status); the old rule missed those too.
UPDATE migration_boards SET synced_read_at = (
  SELECT CAST(min(r.started_at, coalesce(round((julianday(json_extract(l.data, '$.readAt')) - 2440587.5) * 86400000), r.started_at)) AS INTEGER)
  FROM migration_runs r LEFT JOIN migration_logs l ON l.run_id = r.id AND l.code = 'run.started'
  WHERE r.id = (SELECT max(id) FROM migration_runs WHERE migration_id = migration_boards.migration_id AND kind IN ('apply', 'undo'))
)
WHERE synced_read_at IS NULL AND applied = 1
  AND (SELECT status FROM migrations WHERE id = migration_boards.migration_id) = 'completed'
  AND (SELECT kind || ':' || status FROM migration_runs
       WHERE id = (SELECT max(id) FROM migration_runs WHERE migration_id = migration_boards.migration_id AND kind IN ('apply', 'undo'))) = 'apply:succeeded';
