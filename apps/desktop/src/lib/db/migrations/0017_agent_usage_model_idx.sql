-- Index agent_usage.model_id so the usage dashboard's per-model breakdown
-- (groupBy modelId) doesn't full-scan as run history grows. Additive, idempotent.
CREATE INDEX IF NOT EXISTS `agent_usage_model_idx` ON `agent_usage` (`model_id`);
