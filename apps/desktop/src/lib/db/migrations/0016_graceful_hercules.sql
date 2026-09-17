CREATE TABLE IF NOT EXISTS `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text DEFAULT 'user' NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`body` text NOT NULL,
	`apply_mode` text DEFAULT 'always' NOT NULL,
	`glob_pattern` text,
	`enabled` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rules_scope_idx` ON `rules` (`scope`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rules_project_idx` ON `rules` (`project_id`);