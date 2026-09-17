# Scene stuck in `verify_status: 'verifying'`

**Symptom.** A scene's preview never resolves; the PreviewPlayer shows the loading or error card; agent tool results report the scene as not verified.

**Cause.** The offscreen verifier window crashed mid-verify, or the host process was killed before the verifier could stamp `verified` / `errored`. The DB row stays at `'verifying'` because the verifier never returned.

**Fix.**

1. Restart the app. On boot, scenes in `'verifying'` are not re-verified automatically — they remain stuck until edited.
2. If the scene loads fine in the preview, force a re-verify by saving the scene HTML again:
   - In the editor: trigger any change in the Layers tab (e.g. a no-op style toggle).
   - Or via SQLite: `UPDATE scenes SET verify_status='unknown' WHERE id='<sceneId>';` then trigger a scene save in the app.
3. If the scene reliably hangs the verifier (rare):
   - Note the scene's `sceneType` and complexity (HDRI? heavy ThreeJS? infinite loop?).
   - Mark `verify_status='unknown'` to unblock the user.
   - File a bug with the scene HTML + the verifier log line for the stuck attempt.

**Prevention.** The verifier waits up to 3000 ms (`rafWaitMs`) for first paint with an 8000 ms total timeout. Scenes that exceed 8s wall-clock are killed and stamped `errored`, never left in `'verifying'`.

**File pointers.** `apps/desktop/src/lib/services/scene-verifier.ts`, `apps/desktop/src/electron/ipc/scene.ts`.
