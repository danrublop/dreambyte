# Bundled MediaPipe models

Pre-trained model artifacts shipped with Dreambyte for offline use.

## Files

| File                            | Use                                                                 | Size   | Source                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `blaze_face_short_range.tflite` | FaceDetector for `auto_reframe` (short-range, ~2m subject distance) | 229 KB | https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite |

## License

These models are distributed under the **Apache License 2.0** by Google as part of MediaPipe. See:
https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE

The Dreambyte repository's own license applies to the Dreambyte source code; the bundled model retains Google's Apache-2.0 license. Including a copy is permitted by Apache-2.0 §4 (attribution + license-notice carry).

## Build-time wiring

`scripts/build/build-electron.mjs` copies `resources/mediapipe/*.tflite` into
`dist-electron/mediapipe-models/` at build time. The browser-target
`src/electron/mediapipe-detector-page.ts` loads the model from the
relative path `./mediapipe-models/blaze_face_short_range.tflite` —
no network call required after the first build.

## Updating

To pick up a newer FaceDetector model, re-download from MediaPipe's
model garden:
https://developers.google.com/mediapipe/solutions/vision/face_detector

Replace the file in `resources/mediapipe/` and commit. The build will
pick it up on next run.
