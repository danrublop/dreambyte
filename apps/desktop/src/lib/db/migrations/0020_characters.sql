-- Character bundles (T12): a reusable character identity = reference image set + pinned seed
-- + i2i model + style descriptor. Reusing a character conditions generation on its primary
-- reference AND its seed so the same subject re-appears across scenes (Higgsfield-style
-- consistency). Reference images live in project_assets; this table just names the bundle.
-- Idempotent + hand-authored (the repo keeps only sparse drizzle-kit snapshots, so generate
-- can't diff a clean base — see project_migration_merge_renumber).
CREATE TABLE IF NOT EXISTS `characters` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`reference_asset_ids` text DEFAULT '[]' NOT NULL,
	`seed` integer,
	`model` text,
	`strength` real,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `characters_project_idx` ON `characters` (`project_id`);
--> statement-breakpoint
-- One character per name per project, case-insensitive: names are the handle reuse_character
-- selects by, so duplicates would render the wrong bundle.
CREATE UNIQUE INDEX IF NOT EXISTS `characters_project_name_unique` ON `characters` (`project_id`, lower(`name`));
