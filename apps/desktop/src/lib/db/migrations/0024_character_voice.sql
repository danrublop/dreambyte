-- 0024: Tier 3 Cast (Slice 3) — bind a cloned voice to a character.
-- Hand-trimmed additive delta (matching the 0011-0023 convention). A "Cast member" = a characters
-- row with both a face (reference_asset_ids[0]) and a voice (voice_id → cloned_voices.id). Nullable:
-- legacy/face-only characters have no voice. SQLite permits a REFERENCES clause on ADD COLUMN when
-- the column's default is NULL (it is), so the FK + ON DELETE set null are declared inline and
-- backfill every existing row to NULL.
ALTER TABLE `characters` ADD COLUMN `voice_id` text REFERENCES `cloned_voices`(`id`) ON DELETE set null;
