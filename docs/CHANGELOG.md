# Changelog

All notable changes to Dreambyte are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions use Dreambyte's four-part
`MAJOR.MINOR.PATCH.BUILD` scheme (see `version` in `package.json`).

## [Unreleased]

## [0.7.28.0] - 2026-09-16

First public release, under the MIT License.

### Added

- Desktop AI video editor (Electron + Next.js): describe a video and an agent plans and builds
  animated scenes, then every layer stays editable on a multi-track timeline.
- One agent that plans and builds the whole video, with optional Explore, Plan, and Verification
  sub-agents, working with Anthropic, OpenAI, Google Gemini, DeepSeek, Kimi, Qwen, or local models
  via Ollama / OpenAI-compatible endpoints.
- Ten deterministic, seekable scene renderers: SVG, Canvas2D, motion (HTML/CSS + anime.js), D3,
  Three.js, Lottie, Zdog, React, 3D worlds, and avatar scenes.
- Timeline editing: trimming, splitting, snapping, keyframes, clip colour labels, audio gain and
  mixing, colour grading (LUTs, wheels, curves), camera moves, and style presets.
- Optional image, video, avatar, speech, music, sound-effect, and stock media providers (bring your
  own keys), plus a local music composer and footage, screen, microphone, and webcam capture.
- Interactive publishing (hotspots, choices, quizzes, branching) for the `@dreambyte/player`
  runtime.
- MCP server so Claude Code, Cursor, or any MCP client can drive the running app.
- MP4 export (720p to 4K, 24–60 fps) and FCPXML export. MP4 export uses your installed FFmpeg,
  which is not bundled (install it with `brew install ffmpeg-full` or from ffmpeg.org, or set
  `DREAMBYTE_FFMPEG_PATH`).

[Unreleased]: https://github.com/danrublop/dreambyte/compare/v0.7.28.0...HEAD
[0.7.28.0]: https://github.com/danrublop/dreambyte/releases/tag/v0.7.28.0
