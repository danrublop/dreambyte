-- 0029: avatar_videos durability (v4 #8).
--
-- Hand-trimmed additive delta (matching the 0011-0028 convention): the
-- drizzle/sqlite meta snapshot is stale (stops at 0016), so `db:generate` would
-- emit a full "create everything" baseline that fails on a populated DB.
--
-- Persist the async HeyGen poll handle (heygen_video_id) and a render deadline
-- (deadline_at) on the row so the SERVER poll (pollHeygenStatus) can correlate a
-- poll back to its row: time out a wedged render and flip status to error even
-- with no editor window open, and mark the row ready on completion (fixing the
-- orphaned 'generating' row). Both nullable — only the async HeyGen submit sets
-- them; sync/other providers leave them NULL and poll as before. ADD COLUMN is
-- allowed by SQLite.
ALTER TABLE `avatar_videos` ADD COLUMN `heygen_video_id` text;
--> statement-breakpoint
ALTER TABLE `avatar_videos` ADD COLUMN `deadline_at` integer;
--> statement-breakpoint
CREATE INDEX `avatar_videos_heygen_video_idx` ON `avatar_videos` (`heygen_video_id`);
