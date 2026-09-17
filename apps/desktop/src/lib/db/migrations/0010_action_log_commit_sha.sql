-- P5-bridge of NLE-FOUNDATION.
-- Plumb commit SHAs into action_log so the diff viewer can fetch only the
-- actions between two commits. Rows written before a commit have
-- commit_sha = NULL; the post-commit hook stamps them.
--> statement-breakpoint
ALTER TABLE `action_log` ADD COLUMN `commit_sha` text;
--> statement-breakpoint
CREATE INDEX `action_log_commit_idx` ON `action_log` (`project_id`, `commit_sha`);
