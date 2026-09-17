CREATE TABLE `project_branches` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`description` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `branches_project_name_idx` ON `project_branches` (`project_id`,`name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `branches_project_default_idx` ON `project_branches` (`project_id`) WHERE `is_default` = 1;
--> statement-breakpoint
CREATE INDEX `branches_project_idx` ON `project_branches` (`project_id`);
--> statement-breakpoint
CREATE TABLE `scene_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`scene_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`layer_snapshot` text NOT NULL,
	`operation` text,
	`label` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `project_branches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scene_versions_unique_idx` ON `scene_versions` (`scene_id`,`branch_id`,`version_number`);
--> statement-breakpoint
CREATE INDEX `scene_versions_scene_branch_idx` ON `scene_versions` (`scene_id`,`branch_id`);
--> statement-breakpoint
ALTER TABLE `scenes` ADD COLUMN `branch_id` text;
--> statement-breakpoint
CREATE INDEX `scenes_branch_idx` ON `scenes` (`project_id`,`branch_id`);
--> statement-breakpoint
ALTER TABLE `snapshots` ADD COLUMN `branch_id` text;
--> statement-breakpoint
CREATE INDEX `snapshots_branch_idx` ON `snapshots` (`project_id`,`branch_id`);
--> statement-breakpoint
ALTER TABLE `conversations` ADD COLUMN `branch_id` text;
--> statement-breakpoint
CREATE INDEX `conv_branch_idx` ON `conversations` (`project_id`,`branch_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `project_branches` (`id`, `project_id`, `name`, `is_default`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(16))), `id`, 'main', 1, (unixepoch()), (unixepoch())
FROM `projects`;
--> statement-breakpoint
UPDATE `scenes` SET `branch_id` = (
  SELECT `id` FROM `project_branches` WHERE `project_id` = `scenes`.`project_id` AND `is_default` = 1 LIMIT 1
) WHERE `branch_id` IS NULL;
--> statement-breakpoint
UPDATE `snapshots` SET `branch_id` = (
  SELECT `id` FROM `project_branches` WHERE `project_id` = `snapshots`.`project_id` AND `is_default` = 1 LIMIT 1
) WHERE `branch_id` IS NULL;
--> statement-breakpoint
UPDATE `conversations` SET `branch_id` = (
  SELECT `b`.`id` FROM `project_branches` `b` WHERE `b`.`project_id` = `conversations`.`project_id` AND `b`.`is_default` = 1 LIMIT 1
) WHERE `branch_id` IS NULL;
