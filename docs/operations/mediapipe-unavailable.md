# `auto_reframe` errors / MediaPipe detector failures

`auto_reframe` produces keyframes from MediaPipe FaceDetector detections, run in an offscreen window. This runbook covers its failure paths.

**Symptoms.**

- Agent invokes `auto_reframe` and the response is `fail: "auto_reframe failed: ..."`.
- In-app banner indicates reframe failed with a specific reason (model load, video load, seek failure).

**Common causes + fixes.**

1. **FaceDetector model / `FilesetResolver` load error.**
   - The model (`apps/desktop/resources/mediapipe/blaze_face_short_range.tflite`) is bundled: `apps/desktop/scripts/build/build-electron.mjs` copies it to `dist-electron/mediapipe-models/`, and the WASM runtime to `dist-electron/mediapipe-wasm/`. No network access is needed.
   - **Fix:** rebuild with `npm run build:electron` and confirm both directories exist.

2. **`Video has zero dimensions`.**
   - The source URL (`dreambyte://uploads/...`) couldn't be served. Either the file is missing, the protocol handler is misconfigured, or the file is corrupt.
   - **Fix:** verify the clip's `sourceId` resolves to a real file under `<userData>/uploads/`.

3. **`Seek failed at t=N`.**
   - Browser couldn't seek to the requested timestamp. Usually means a corrupted MP4 / missing keyframes / unsupported codec.
   - **Fix:** transcode the source to standard MP4 (`ffmpeg -i in.mp4 -c:v libx264 -preset fast out.mp4`).

4. **`MediaPipe page did not finish loading`.**
   - The offscreen BrowserWindow couldn't load `dist-electron/mediapipe-detector.html`. Usually means the build is stale or `mediapipe-detector-bundle.js` is missing.
   - **Fix:** rebuild — `npm run build:electron`. Verify `dist-electron/mediapipe-detector-bundle.js` and `dist-electron/mediapipe-wasm/` exist.

**Architecture pointers.**

- `apps/desktop/src/electron/mediapipe-detector-page.ts` — browser-target source (bundled to `dist-electron/mediapipe-detector-bundle.js`).
- `apps/desktop/src/electron/mediapipe-detector.html` — loads the bundle inside the offscreen window.
- `apps/desktop/src/electron/mediapipe-detector-host.ts` — main-process IPC transport (`executeDetect`).
- `apps/desktop/src/lib/services/mediapipe-frame-detector.ts` — `FrameDetector` interface wrapper.
- `apps/desktop/src/lib/edit-engines/auto-reframe.ts` — the orchestrator that consumes detections.
- `dist-electron/mediapipe-wasm/` — bundled WASM artifacts (copied from `node_modules/@mediapipe/tasks-vision/wasm` at build time).
