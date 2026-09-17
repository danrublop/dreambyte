-- Agent observability PR 1: enrich agent_usage with provider / outcome / run
-- correlation so the usage dashboard can break spend down by provider and
-- correlate sub-agent runs to their parent.
--
-- Hand-trimmed to the additive delta (matching the 0012 convention): the
-- drizzle/sqlite meta snapshot is stale, so `db:generate` would emit a full
-- "create everything" baseline that fails on a populated DB. These columns are
-- nullable on purpose — rows written before this migration have no provider /
-- outcome / runId, and the summary query coalesces missing providers to
-- 'unknown'.
ALTER TABLE `agent_usage` ADD COLUMN `provider` text;--> statement-breakpoint
ALTER TABLE `agent_usage` ADD COLUMN `outcome` text;--> statement-breakpoint
ALTER TABLE `agent_usage` ADD COLUMN `run_id` text;--> statement-breakpoint
ALTER TABLE `agent_usage` ADD COLUMN `parent_run_id` text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_usage_provider_idx` ON `agent_usage` (`provider`);
