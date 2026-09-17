-- Research memory. One row per research sub-agent run: the brief, the sources it
-- used, the assets it staged, and a 384-d topic embedding for semantic reuse.
-- Similarity is JS cosine over a project's notes (lib/research/note-ranking.ts) —
-- no vector index, so this is a plain column. embed_model/embed_dim guard against
-- comparing vectors across embedder changes. Idempotent + hand-authored (the repo
-- keeps only sparse drizzle-kit snapshots — see project_migration_merge_renumber).
CREATE TABLE IF NOT EXISTS `research_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`topic` text NOT NULL,
	`brief` text NOT NULL,
	`sources` text DEFAULT '[]' NOT NULL,
	`asset_ids` text DEFAULT '[]' NOT NULL,
	`embedding` text,
	`embed_model` text,
	`embed_dim` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `research_notes_project_idx` ON `research_notes` (`project_id`,`created_at`);
