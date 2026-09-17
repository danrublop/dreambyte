-- Track type expansion (P2 of NLE-FOUNDATION).
-- Expand timeline_tracks.type from video|audio|overlay to the 6-value
-- enum that the agent + UI need. Legacy 'overlay' rows are remapped to
-- 'graphics' (the new generic kind for non-media decorative tracks).
-- Also adds the solo/hidden columns introduced by the Track type update.
--> statement-breakpoint
UPDATE timeline_tracks SET type = 'graphics' WHERE type = 'overlay';
--> statement-breakpoint
ALTER TABLE timeline_tracks ADD COLUMN solo INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE timeline_tracks ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
