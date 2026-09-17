-- 0023: Tier 3 Cast (Slice 2) — cloned voices + project voice-clone consent.
-- Hand-trimmed additive delta (matching the 0011-0022 convention): the drizzle/sqlite meta
-- snapshot is sparse, so `db:generate` would emit a full baseline that fails on a populated DB.
--
-- cloned_voices: a third-party (ElevenLabs) or local (VoxCPM) voiceprint made from a user sample.
-- The raw biometric audio is NOT stored — only the provider voice id, sample metadata, and a
-- consent audit snapshot. characters.voice_id (Slice 3) references this.
CREATE TABLE IF NOT EXISTS `cloned_voices` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`provider_voice_id` text NOT NULL,
	`sample_mime` text,
	`sample_bytes` integer,
	`consent_at` integer NOT NULL,
	`consent_version` text NOT NULL,
	`consent_destination` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `cloned_voices_project_idx` ON `cloned_voices` (`project_id`);
--> statement-breakpoint
-- One cloned voice per name per project, case-insensitive (the picker/agent selects by name).
CREATE UNIQUE INDEX IF NOT EXISTS `cloned_voices_project_name_unique` ON `cloned_voices` (`project_id`, lower(`name`));
--> statement-breakpoint
-- voice_clone_consents: consent per (project, destination) — "once per project, then remembered",
-- recorded per named third-party so each destination keeps its own contemporaneous consentAt+version
-- (a later consent to a 2nd destination must not overwrite the 1st destination's audit). Biometric
-- uploads are fail-closed on the absence of a row for that destination (or a fresh consent in the call).
CREATE TABLE IF NOT EXISTS `voice_clone_consents` (
	`project_id` text NOT NULL,
	`destination` text NOT NULL,
	`version` text NOT NULL,
	`consent_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY (`project_id`, `destination`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
