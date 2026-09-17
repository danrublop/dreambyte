-- 0018: backend operation model for the branch-management card.
--
-- Hand-trimmed additive delta (matching the 0011-0017 convention): the
-- drizzle/sqlite meta snapshot is stale, so `db:generate` would emit a full
-- "create everything" baseline that fails on a populated DB.
--
-- 1. projects.status — 'forking' hides a half-built fork until its assets finish
--    copying; flipped to 'ready' on success. ADD COLUMN with a NOT NULL default
--    is allowed by SQLite and backfills every existing row to 'ready'.
ALTER TABLE `projects` ADD COLUMN `status` text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
-- 2. scene_versions.batch_id — groups all scene-versions written by one logical
--    operation so branch history restores by operation boundary, not raw time.
--    Nullable: legacy rows have no batch and fall back to per-row restore.
ALTER TABLE `scene_versions` ADD COLUMN `batch_id` text;--> statement-breakpoint
-- 3. Branch-wide history timeline index: all versions on a branch, newest first,
--    in one paginated indexed scan (no per-scene N+1).
CREATE INDEX IF NOT EXISTS `scene_versions_branch_created_idx` ON `scene_versions` (`branch_id`, `created_at`);--> statement-breakpoint
-- 4. branch_locks — cross-process advisory lock for branch-mutating ops. The
--    in-memory Zustand flag only guards one window; agents run in separate
--    Electron windows / worktrees against the same SQLite file, so the
--    authoritative lock lives in the DB. PK on branch_id = at most one holder.
CREATE TABLE IF NOT EXISTS `branch_locks` (
	`branch_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`operation` text NOT NULL,
	`heartbeat_at` integer DEFAULT (unixepoch()) NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`branch_id`) REFERENCES `project_branches`(`id`) ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade
);
