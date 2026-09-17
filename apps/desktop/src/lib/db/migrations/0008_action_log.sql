-- Action layer (P1 of NLE-FOUNDATION).
-- Append-only action stream is the deepest truth (locked decision #6); the
-- scenes/layers/projects tables become projections that can always be
-- rebuilt from action_log + WAL.
--> statement-breakpoint
CREATE TABLE `action_log` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `branch_id` text,
  `type` text NOT NULL,
  `source` text NOT NULL,
  `run_id` text,
  `version` integer DEFAULT 1 NOT NULL,
  `params` text NOT NULL,
  `inverse_params` text,
  `result_blob_hash` text,
  `nondeterministic` integer DEFAULT 0 NOT NULL,
  `timestamp` integer NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `action_log_project_idx` ON `action_log` (`project_id`);
--> statement-breakpoint
CREATE INDEX `action_log_branch_ts_idx` ON `action_log` (`branch_id`, `timestamp`);
--> statement-breakpoint
CREATE INDEX `action_log_run_idx` ON `action_log` (`run_id`);
--> statement-breakpoint
-- Materialized projection. Refreshed every 500 actions (perf finding #1) so
-- cold load = latest snapshot + tail replay. Avoids 2.5s+ replays on
-- long-lived projects. One row per (project, branch).
CREATE TABLE `materialized_state` (
  `project_id` text NOT NULL,
  `branch_id` text,
  `last_action_id` text,
  `state` text NOT NULL,
  `created_at` integer NOT NULL,
  PRIMARY KEY (`project_id`, `branch_id`)
);
--> statement-breakpoint
-- Content-addressable blob store metadata (codex outside-voice correction).
-- Actions reference `blob_hash` instead of inlining scene HTML / generated
-- code / audio. Files live at <user-data>/projects/{projectId}/blobs/<hash>;
-- this table tracks refcount + size + mime for GC. P1a writes none of
-- these — the rows land when `layer/regenerate` and friends ship in P1.5
-- with the effect-runner.
CREATE TABLE `blobs` (
  `hash` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `mime` text NOT NULL,
  `size_bytes` integer NOT NULL,
  `refcount` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `blobs_project_idx` ON `blobs` (`project_id`);
