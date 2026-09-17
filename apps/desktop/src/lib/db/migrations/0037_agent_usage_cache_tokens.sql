-- Prompt-cache accounting on agent_usage.
--
-- The runner has always collected cache_creation_input_tokens and
-- cache_read_input_tokens off the Anthropic message_start event, accumulated them
-- across turns, and then dropped them on the floor at the INSERT. Consequence: every
-- audit of this codebase recorded the cache hit rate as "unmeasured", and the caching
-- work in #388 and #402 shipped with no way to tell afterwards whether it worked.
--
-- Nullable on purpose. Existing rows have no value, and defaulting them to 0 would
-- read as "this run got no cache hits" instead of "this run predates the column" —
-- the same lie, pointing the other way. Readers must coalesce explicitly.
ALTER TABLE `agent_usage` ADD `cache_creation_tokens` integer;--> statement-breakpoint
ALTER TABLE `agent_usage` ADD `cache_read_tokens` integer;
