-- Video start-cache (T9-tail): request_hash dedupes identical re-requests at start;
-- video_url lets a 'done' job (real or cache-hit) return its clip without re-polling the
-- provider. Hand-authored (repo keeps sparse drizzle snapshots — see 0018_video_jobs.sql).
ALTER TABLE `video_jobs` ADD `request_hash` text;
--> statement-breakpoint
ALTER TABLE `video_jobs` ADD `video_url` text;
