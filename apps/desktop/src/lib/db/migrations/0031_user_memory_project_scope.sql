-- 0031: user_memory project scope (PR-B / T1).
--
-- Hand-trimmed additive delta (matching the 0011-0030 convention): the
-- drizzle/sqlite meta snapshot is stale (stops at 0016), so `db:generate` would
-- emit a full "create everything" baseline that fails on a populated DB.
--
-- Add a nullable project_id so a learned preference can be scoped to ONE
-- project (NULL = a user-global memory applying to every project). Workspace
-- taste is NOT duplicated here — it stays in workspaces.brandKit/globalStyle
-- and is merged as the middle precedence layer at read time. Precedence:
--   project-memory > workspace.brandKit > user-memory.
--
-- The original unique index (user_id, category, key) is replaced by a scoped
-- unique index over (user_id, coalesce(project_id,''), category, key): NULL is
-- DISTINCT in a SQLite UNIQUE index, so without the coalesce many global rows
-- could collide on (user, cat, key); coalescing NULL -> '' collapses every
-- global row to one stable scope token so the global slot stays unique while
-- each project keeps its own (cat, key) slot. A plain composite index over the
-- same columns (without the coalesce) backs the scoped lookup query.
ALTER TABLE `user_memory` ADD COLUMN `project_id` text REFERENCES `projects`(`id`) ON DELETE set null;
--> statement-breakpoint
DROP INDEX IF EXISTS `user_memory_user_key_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `user_memory_user_scope_key_idx` ON `user_memory` (`user_id`,coalesce(`project_id`, ''),`category`,`key`);
--> statement-breakpoint
CREATE INDEX `user_memory_user_project_key_idx` ON `user_memory` (`user_id`,`project_id`,`category`,`key`);
