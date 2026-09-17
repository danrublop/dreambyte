-- Media generations (pro-style reactive job record). One lifecycle row per async AI-media
-- generation across all kinds (video/image/audio/avatar), so a MAIN-PROCESS job runner can own
-- the poll loop off the agent and push status to the renderer. Cost reserve/commit + request-hash
-- dedupe stay on `video_jobs`; this references the same operation_name. Idempotent + hand-authored
-- (the repo keeps only sparse drizzle-kit snapshots — see project_migration_merge_renumber).
CREATE TABLE IF NOT EXISTS `media_generations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`provider` text NOT NULL,
	`operation_name` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`prompt` text,
	`scene_id` text,
	`layer_id` text,
	`clip_id` text,
	`result_url` text,
	`result_duration_ms` integer,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`deadline_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `media_gen_project_idx` ON `media_generations` (`project_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `media_gen_status_idx` ON `media_generations` (`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `media_gen_op_idx` ON `media_generations` (`operation_name`);
