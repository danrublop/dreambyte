-- Add source discriminator to scene_versions so the history panel can filter
-- autosave noise from meaningful versions without a full table scan.
-- 'autosave' = scheduled from user save path (was operation: 'user_edit')
-- 'agent'    = from agent run (was operation: 'agent_run')
-- 'user'     = manually pinned by user
-- 'restore'  = written before/after a version restore
-- 'branch-init' = written once when a branch is forked from current
--> statement-breakpoint
ALTER TABLE scene_versions ADD COLUMN source TEXT NOT NULL DEFAULT 'autosave';
