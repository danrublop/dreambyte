# Dreambyte Telemetry

Anonymous, fire-and-forget event pipeline that is inert until you configure an endpoint. Lives in `apps/desktop/src/lib/telemetry.ts` and is wired into `apps/desktop/src/electron/main.ts` + `apps/desktop/src/electron/ipc/settings.ts`.

> **Two pipelines, one opt-out.** This doc covers **product analytics** (`apps/desktop/src/lib/telemetry.ts`, PostHog-shaped). Its counterpart is **crash/error telemetry** (`apps/desktop/src/lib/crash-telemetry.ts`, `@sentry/electron`) — opt-out, PII-free, keyed to `dreambyte@<version>+<buildNumber>` so a stack trace maps to the exact published build. It is inert until `DREAMBYTE_SENTRY_DSN` is set, and it shares the exact opt-out signals below, so one env var or marker file disables BOTH. `dist:mac`, `dist:win`, and `dist:publish` upload build symbols via `apps/desktop/scripts/release/upload-sentry-symbols.mjs`, which is a no-op unless `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT` are set.

## What's collected

Per event:

- Event name (e.g. `app_launched`, `scene_generated`, `export_started`)
- A flat properties bag of small primitives (counts, durations, enum values, success/failure flags)
- An anonymous device ID (UUID, generated on first run, persisted to `<userData>/device-id`, never derived from user identity)
- App version + platform + arch (auto-attached)

## What is NOT collected

- Project / scene / conversation names or content
- Prompt text, generated code, scene HTML
- File paths, file contents, environment variables
- API keys (provider keys never leave the user's machine)
- User email, name, account identity

One event is an exception that carries short free text — see `app_launch_failed` below.

The contract is enforced by convention — callers pass small primitives via the `properties` arg. String properties longer than 4,096 characters are truncated. Anything over 200 events gets dropped (oldest first). The track helper never throws.

## How to enable sending

Telemetry is **off by default** until you configure an endpoint. To turn it on, set in `<userData>/dreambyte.env` (or `.env.local` for dev):

```
DREAMBYTE_TELEMETRY_URL=https://us.i.posthog.com/i/v0/e/
DREAMBYTE_TELEMETRY_API_KEY=phc_<your-posthog-project-key>
```

PostHog is the default-recommended provider — public capture endpoint, no auth beyond the project key, generous free tier. To use a different provider, point `DREAMBYTE_TELEMETRY_URL` at any endpoint that accepts:

```json
{
  "api_key": "...",
  "batch": [
    {
      "event": "app_launched",
      "distinct_id": "<uuid>",
      "properties": { "...": "..." },
      "timestamp": "2026-04-19T..."
    }
  ]
}
```

## Opt-out (three layers, any disables)

1. **Env var:** `DREAMBYTE_TELEMETRY_DISABLED=1` (kill switch for CI / dev)
2. **File marker:** `<userData>/.telemetry-disabled` exists (create it manually; the `settings.setTelemetry` IPC handler writes it, but there is no Settings toggle yet)
3. **No endpoint configured:** `DREAMBYTE_TELEMETRY_URL` is unset (the default state — safe-by-default)

## Currently wired events

- `app_launched` (`apps/desktop/src/electron/main.ts`) — fired after migrations succeed. Properties: `packaged: bool`, `migration_ms: number`
- `app_launch_failed` (`apps/desktop/src/electron/main.ts`) — fired on migration error. Properties: `reason: string`, `message: string` (first 200 chars of the error message, which can include a file path)
- `agent_run_completed` (`apps/desktop/src/lib/agents/run-analytics.ts`) — fired at the end of each agent run. Properties are bucketed, never raw: `outcome`, `frustrationLevel`, `costBand`, `durationBand`, `provider`
- `agent_feedback` (`apps/desktop/src/lib/agents/tool-handlers/feedback-tools.ts`) — fired when the agent calls its `send_feedback` tool to report a tool gap (at most 8 per run). Carries no text: `category` and `severity` (enums), `summary_chars` and `details_chars` (lengths), `recent_tool_count`, `has_last_error`, and `summary_hash` / `last_error_hash` (the first 16 hex characters of a SHA-256, so repeat reports can be grouped without the text). The full report — the model's summary and details, recent tool names, the last tool error, a project-ID prefix and the model ID — is only appended to the local `~/.dreambyte/agent-feedback.jsonl`, whether or not telemetry is enabled.
- `telemetry_enabled` (`apps/desktop/src/electron/ipc/settings.ts`) — fired when telemetry is switched on via `settings.setTelemetry`

The preload also exposes `dreambyteApi.settings.trackEvent({ event, properties })` for renderer events; no renderer code calls it yet.

## Settings UI integration (not built yet)

The IPC surface is ready:

```ts
// In any renderer Settings panel:
const { enabled } = await window.dreambyteApi.settings.getTelemetry()
// ...render toggle...
await window.dreambyteApi.settings.setTelemetry({ enabled: false })
```

For analytics the change applies to the next event. Crash reporting is initialized once at startup, so it picks up the change on the next launch.

## Transport behavior

- **Flush interval:** 30 seconds, plus a final flush on app quit (`before-quit` handler).
- **Network timeout:** 5 seconds per flush. Drops the batch on timeout.
- **Queue cap:** 200 events. Beyond that, oldest events are dropped.
- **Failure mode:** logs a warn line, never throws. Telemetry must never block the app.

## Architecture

All network egress runs in the Electron main process. The renderer never directly hits a telemetry endpoint — everything routes through the `dreambyte:settings.trackEvent` IPC handler. This keeps the opt-out gate, sandbox rules, and key handling in one place.
