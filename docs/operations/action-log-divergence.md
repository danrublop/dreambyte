# `action_log` diverges from WAL

**Symptom.** Boot-time WAL replay reports actions that don't appear in the `action_log` DB table, or vice versa. Undo restores an unexpected prior state.

**Cause.** The action layer has two persistence paths: synchronous WAL append on disk (crash-safe, `apps/desktop/src/lib/actions/wal.ts`) and asynchronous `action_log` INSERT (queryable, `apps/desktop/src/lib/db/queries/action-log.ts`). If the OS lies about `fsync()` or the process crashes between WAL append and DB INSERT, the two paths can drift apart.

**Recovery rule: WAL wins.** The WAL is by definition the deepest truth — every dispatched action is appended synchronously before the reducer runs. The `action_log` is a projection of the WAL, not the other way around.

**Fix.**

1. **Boot replay should self-correct.** At startup `apps/desktop/src/lib/actions/wal-replay.ts` scans each project's WAL, re-inserts any rows missing from `action_log` (inserts are idempotent on action id), and then truncates the WAL.
2. **If boot replay does NOT self-correct** (e.g. WAL file unreadable / corrupted):
   - Locate the WAL file at `<userData>/projects/<projectId>/wal.jsonl` (see `walPath` in `apps/desktop/src/lib/actions/wal.ts`). Corrupt lines are skipped and the file is quarantined as `wal.<timestamp>.corrupt.jsonl` next to it.
   - Inspect the tail with `tail -100 <userData>/projects/<projectId>/wal.jsonl`.
   - If the tail has more entries than `action_log` (compare action ids), the DB lost a write. Re-insert manually or accept the drift if older than a few minutes.
   - If `action_log` has more entries than the WAL, the WAL was truncated. This is rare and indicates an `fsync` lie; the safest move is to truncate `action_log` back to the last shared entry.
3. **If both are corrupted**, restore the most recent snapshot from `apps/desktop/src/lib/db/queries/materialized-state.ts` (snapshots are written every 500 actions by `apps/desktop/src/lib/actions/snapshot-orchestrator.ts`).

**Reporting.** Attach the WAL file and a `SELECT id, type, created_at FROM action_log ORDER BY created_at DESC LIMIT 20;` to the bug report.

**File pointers.** `apps/desktop/src/lib/actions/wal.ts`, `apps/desktop/src/lib/actions/wal-replay.ts`, `apps/desktop/src/lib/db/queries/action-log.ts`, `apps/desktop/src/lib/actions/snapshot-orchestrator.ts`.
