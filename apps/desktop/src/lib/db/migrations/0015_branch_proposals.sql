-- 0015: branch-scope the agent's proposal / handoff state.
--
-- These fields lived on `projects` (one row per project), but everything they
-- reference (scenes, action_log, snapshots, conversations) is branch-scoped, so
-- a proposal made on branch A was read by branch B. Move them to
-- `branch_proposals`, keyed (project_id, branch_id), mirroring `materialized_state`.
--
-- Ordering: create table -> ensure each project has a default branch row ->
-- backfill the columns onto that row -> drop the columns from `projects`.
-- The additive steps are idempotent (IF NOT EXISTS / NOT EXISTS / ON CONFLICT).
-- The destructive drops come LAST. If they fail mid-way (only possible via the
-- non-atomic sequential fallback in lib/db/migrate.ts; the primary migrate()
-- path is transactional), a re-run errors on an already-dropped column. The
-- moved fields are ephemeral, re-derivable working state (a pending proposal /
-- paused run) — recovery is to restore the DB, not reconstruct data.
--
-- Hand-trimmed to the additive delta (matching the 0011-0014 convention): the
-- drizzle/sqlite meta snapshot is stale, so `db:generate` would emit a full
-- "create everything" baseline that fails on a populated DB.
CREATE TABLE IF NOT EXISTS `branch_proposals` (
  `project_id` text NOT NULL,
  `branch_id` text NOT NULL,
  `storyboard_proposed` text,
  `storyboard_edited` text,
  `storyboard_applied` text,
  `structural_cuts_proposed` text,
  `paused_agent_run` text,
  `run_checkpoint` text,
  `version` integer DEFAULT 0 NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`project_id`, `branch_id`),
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade,
  FOREIGN KEY (`branch_id`) REFERENCES `project_branches`(`id`) ON DELETE cascade
);
--> statement-breakpoint
-- Ensure every project has a default branch row to attach proposals to. Mirrors
-- getOrCreateDefaultBranch (branches.ts): is_default=1, name 'main'. The
-- NOT EXISTS guard makes it idempotent; ON CONFLICT DO NOTHING guards the
-- (project_id, name) unique index in the rare case a non-default 'main' exists.
--
-- id MUST be 8-4-4-4-12 UUID format: assertValidUuid (electron/ipc/_helpers.ts)
-- rejects bare 32-char hex, and migration 0005 exists solely to repair branch
-- ids that were seeded as bare hex. Format one randomblob(16) per row (inner
-- subquery so randomblob is evaluated ONCE, not five times) exactly like 0005.
INSERT INTO `project_branches` (`id`, `project_id`, `name`, `is_default`, `created_at`, `updated_at`)
SELECT
  (SELECT lower(substr(h,1,8)||'-'||substr(h,9,4)||'-'||substr(h,13,4)||'-'||substr(h,17,4)||'-'||substr(h,21))
   FROM (SELECT hex(randomblob(16)) AS h)),
  p.`id`, 'main', 1, strftime('%s','now'), strftime('%s','now')
FROM `projects` p
WHERE NOT EXISTS (
  SELECT 1 FROM `project_branches` b WHERE b.`project_id` = p.`id` AND b.`is_default` = 1
)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Backfill: move each project's proposal columns onto its default branch row.
-- Only projects with at least one non-null field get a row (no empty rows).
-- Lossy-attribution note: if a project already had multiple branches, this state
-- was never branch-correct — it lands on the default branch, best-effort.
INSERT INTO `branch_proposals` (
  `project_id`, `branch_id`, `storyboard_proposed`, `storyboard_edited`,
  `storyboard_applied`, `structural_cuts_proposed`, `paused_agent_run`,
  `run_checkpoint`, `version`, `updated_at`
)
SELECT p.`id`, b.`id`, p.`storyboard_proposed`, p.`storyboard_edited`,
       p.`storyboard_applied`, p.`structural_cuts_proposed`, p.`paused_agent_run`,
       p.`run_checkpoint`, 0, (strftime('%s','now') * 1000)
FROM `projects` p
JOIN `project_branches` b ON b.`project_id` = p.`id` AND b.`is_default` = 1
WHERE p.`storyboard_proposed` IS NOT NULL
   OR p.`storyboard_edited` IS NOT NULL
   OR p.`storyboard_applied` IS NOT NULL
   OR p.`structural_cuts_proposed` IS NOT NULL
   OR p.`paused_agent_run` IS NOT NULL
   OR p.`run_checkpoint` IS NOT NULL
ON CONFLICT (`project_id`, `branch_id`) DO NOTHING;
--> statement-breakpoint
ALTER TABLE `projects` DROP COLUMN `storyboard_proposed`;
--> statement-breakpoint
ALTER TABLE `projects` DROP COLUMN `storyboard_edited`;
--> statement-breakpoint
ALTER TABLE `projects` DROP COLUMN `storyboard_applied`;
--> statement-breakpoint
ALTER TABLE `projects` DROP COLUMN `structural_cuts_proposed`;
--> statement-breakpoint
ALTER TABLE `projects` DROP COLUMN `paused_agent_run`;
--> statement-breakpoint
ALTER TABLE `projects` DROP COLUMN `run_checkpoint`;
