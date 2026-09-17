-- Phase 2.5: media-analysis content-addressed cache.
-- Hand-trimmed to the additive delta only: `db:generate` produced a full
-- "create everything" baseline because the drizzle/sqlite meta snapshot is
-- stale (pre-existing — action_log etc. are already in the DB). Applying that
-- baseline would fail on a populated DB, so this migration creates only the new
-- table, idempotently.
CREATE TABLE IF NOT EXISTS `media_analysis` (
	`id` text PRIMARY KEY NOT NULL,
	`content_hash` text NOT NULL,
	`engine_id` text NOT NULL,
	`kind` text NOT NULL,
	`model_version` text DEFAULT '' NOT NULL,
	`analysis` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `media_analysis_lookup_idx` ON `media_analysis` (`content_hash`,`engine_id`,`model_version`);
