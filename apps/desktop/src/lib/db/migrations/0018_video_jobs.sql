-- Video job durability (T9): persist in-flight text-to-video jobs with a deadline so the
-- stateless poll loop can time out a wedged job, release its reservation, and stop polling
-- forever. Keyed by operation_name (the id the poll loop already carries). Idempotent +
-- hand-authored (the repo keeps only sparse drizzle-kit snapshots, so generate can't diff
-- a clean base — see project_migration_merge_renumber).
CREATE TABLE IF NOT EXISTS `video_jobs` (
	`operation_name` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`provider` text NOT NULL,
	`reservation_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`deadline_at` integer NOT NULL,
	`error_reason` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
