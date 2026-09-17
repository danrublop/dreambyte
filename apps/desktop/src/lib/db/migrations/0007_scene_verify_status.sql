-- P0 verify-scene gate (NLE-FOUNDATION).
-- Every scene write spins up an offscreen BrowserWindow and reports back
-- one of: 'verified' | 'errored' | 'unknown' (CSS-only / verifier unavailable).
-- 'pending' is a transient in-memory state during the verify run; rows on
-- disk are never observed in 'pending' from the renderer because the IPC
-- write awaits the verifier before returning. We still allow it as a column
-- value for crash-recovery audits (a row stuck on 'pending' = process died
-- mid-verify; UI treats it as 'unknown' until the next write).
--> statement-breakpoint
ALTER TABLE scenes ADD COLUMN verify_status TEXT NOT NULL DEFAULT 'unknown';
--> statement-breakpoint
ALTER TABLE scenes ADD COLUMN verify_error TEXT;
--> statement-breakpoint
ALTER TABLE scenes ADD COLUMN verified_at INTEGER;
