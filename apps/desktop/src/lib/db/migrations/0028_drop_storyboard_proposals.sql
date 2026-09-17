-- T9: the storyboard is no longer a user-facing or persisted proposal artifact.
-- The written plan (Phase 3 plan surface) is the only user-facing planning
-- artifact; the storyboard survives solely as an in-memory build-spec inside a
-- run (world.storyboard) and inside run checkpoints' JSON. Drop the three
-- branch-scoped proposal columns added in 0015.
--
-- SQLite DROP COLUMN (3.35+) rewrites the table row-by-row; branch_proposals
-- rows are small JSON blobs keyed (project_id, branch_id), so this is cheap.
ALTER TABLE `branch_proposals` DROP COLUMN `storyboard_proposed`;--> statement-breakpoint
ALTER TABLE `branch_proposals` DROP COLUMN `storyboard_edited`;--> statement-breakpoint
ALTER TABLE `branch_proposals` DROP COLUMN `storyboard_applied`;
