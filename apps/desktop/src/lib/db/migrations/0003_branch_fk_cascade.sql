-- Data repair: remove orphaned rows that reference a deleted branch.
-- (Cascade-delete on branch delete is enforced in application code via
-- deleteBranch() in lib/db/queries/branches.ts rather than a SQL trigger,
-- because libsql 0.5.x misinterprets CREATE TRIGGER's SQLITE_OK as an error.)
--> statement-breakpoint
DELETE FROM scenes WHERE branch_id IS NOT NULL AND branch_id NOT IN (SELECT id FROM project_branches);
--> statement-breakpoint
DELETE FROM scene_versions WHERE branch_id IS NOT NULL AND branch_id NOT IN (SELECT id FROM project_branches);
