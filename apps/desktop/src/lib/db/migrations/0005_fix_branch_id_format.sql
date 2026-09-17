-- Migration 0005: Fix branch IDs seeded by 0002 as 32-char hex (no hyphens).
-- lower(hex(randomblob(16))) produces e.g. "a1b2c3d4e5f60708091011121314151"
-- but assertValidUuid requires 8-4-4-4-12 UUID format.
-- Update child tables first (FK enforcement is off in libsql; PK update is safe last).
UPDATE `scenes`
SET `branch_id` = substr(`branch_id`,1,8)||'-'||substr(`branch_id`,9,4)||'-'||substr(`branch_id`,13,4)||'-'||substr(`branch_id`,17,4)||'-'||substr(`branch_id`,21)
WHERE `branch_id` IS NOT NULL AND length(`branch_id`) = 32 AND `branch_id` NOT GLOB '*-*';
--> statement-breakpoint
UPDATE `snapshots`
SET `branch_id` = substr(`branch_id`,1,8)||'-'||substr(`branch_id`,9,4)||'-'||substr(`branch_id`,13,4)||'-'||substr(`branch_id`,17,4)||'-'||substr(`branch_id`,21)
WHERE `branch_id` IS NOT NULL AND length(`branch_id`) = 32 AND `branch_id` NOT GLOB '*-*';
--> statement-breakpoint
UPDATE `conversations`
SET `branch_id` = substr(`branch_id`,1,8)||'-'||substr(`branch_id`,9,4)||'-'||substr(`branch_id`,13,4)||'-'||substr(`branch_id`,17,4)||'-'||substr(`branch_id`,21)
WHERE `branch_id` IS NOT NULL AND length(`branch_id`) = 32 AND `branch_id` NOT GLOB '*-*';
--> statement-breakpoint
UPDATE `scene_versions`
SET `branch_id` = substr(`branch_id`,1,8)||'-'||substr(`branch_id`,9,4)||'-'||substr(`branch_id`,13,4)||'-'||substr(`branch_id`,17,4)||'-'||substr(`branch_id`,21)
WHERE `branch_id` IS NOT NULL AND length(`branch_id`) = 32 AND `branch_id` NOT GLOB '*-*';
--> statement-breakpoint
UPDATE `project_branches`
SET `id` = substr(`id`,1,8)||'-'||substr(`id`,9,4)||'-'||substr(`id`,13,4)||'-'||substr(`id`,17,4)||'-'||substr(`id`,21)
WHERE length(`id`) = 32 AND `id` NOT GLOB '*-*';
