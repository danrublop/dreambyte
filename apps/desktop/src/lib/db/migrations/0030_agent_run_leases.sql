-- 0030: agent_run_leases — cross-process advisory lease for AGENT RUNS (P1-13).
--
-- Hand-trimmed additive delta (matching the 0011-0029 convention): the
-- drizzle/sqlite meta snapshot is stale (stops at 0016), so `db:generate` would
-- emit a full "create everything" baseline that fails on a populated DB.
--
-- Two app windows / git worktrees driving the SAME project share one
-- ~/.dreambyte/studio.db. reserveRunSlot is an in-MEMORY guard — it only
-- serializes runs within ONE window. To stop two WINDOWS from running an agent
-- concurrently on the same (projectId, branchId), the authoritative lease must
-- live in the DB. This mirrors branch_locks exactly (lib/db/queries/branch-locks.ts):
-- atomic upsert-acquire, heartbeat + TTL liveness (a crashed window's lease is
-- reclaimable once its heartbeat passes the TTL), self-only release.
--
-- PK is composite (project_id, branch_id): runs on DIFFERENT branches of the
-- same project may proceed in parallel (the parallel multi-variant spawn);
-- same-branch runs across windows are mutually excluded. branch_id is NOT NULL
-- with a '' default so a null/unset branch normalizes to one stable PK value
-- (SQLite treats NULL as distinct in a PK, which would defeat the exclusion).
CREATE TABLE IF NOT EXISTS `agent_run_leases` (
	`project_id` text NOT NULL,
	`branch_id` text DEFAULT '' NOT NULL,
	`owner_token` text NOT NULL,
	`owner_instance_id` text,
	`owner_pid` integer,
	`run_id` text,
	`heartbeat_at` integer DEFAULT (unixepoch()) NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY (`project_id`, `branch_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade
);
