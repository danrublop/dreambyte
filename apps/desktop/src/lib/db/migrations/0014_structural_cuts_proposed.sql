-- Gap 3.1: persist the post-build cut review's whole-scene-redundancy cut
-- candidates project-scoped, so the structural-cuts review card survives a
-- reload (mirrors storyboard_proposed). Nullable JSON; cleared on apply/dismiss.
--
-- Hand-trimmed to the additive delta (matching the 0012/0013 convention): the
-- drizzle/sqlite meta snapshot is stale, so `db:generate` would emit a full
-- "create everything" baseline that fails on a populated DB.
ALTER TABLE `projects` ADD COLUMN `structural_cuts_proposed` text;
