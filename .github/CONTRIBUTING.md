# Contributing to Dreambyte

Thanks for your interest in improving Dreambyte. Bug reports, fixes, and focused features are all
welcome.

## Development setup

Requirements: Node.js 22 (see `apps/desktop/.nvmrc`), npm, and FFmpeg for MP4 export (`brew install ffmpeg-full`; see
the README's Requirements). macOS is the primary development platform.

```bash
git clone https://github.com/danrublop/dreambyte.git
cd dreambyte
npm ci                          # all workspaces: apps/desktop + packages/*
cd apps/desktop
cp .env.example .env            # optional: add provider keys
npm run dev:desktop             # Electron + renderer watch
```

`README.md` covers configuration and architecture; `apps/desktop/CLAUDE.md` is the detailed codebase reference
(also used by AI coding agents), and `apps/desktop/AGENTS.md` covers driving the app over MCP.

## Checks

Run these from `apps/desktop/` before opening a pull request — CI runs the same set:

```bash
npm run lint
npm run typecheck
npm run test:ci
npm run build:renderer && npm run build:electron
```

A Husky pre-commit hook formats staged files with Prettier.

## Pull requests

- Keep each PR focused on one change, with a clear description of what and why.
- Add or update tests for behavior changes.
- Include a screenshot or short recording for UI changes.
- Note user-facing changes under `[Unreleased]` in `CHANGELOG.md`.
- **Dependencies and assets:** when you add a runtime dependency, regenerate the notices with
  `node apps/desktop/scripts/release/gen-third-party-notices.mjs` (after `npm ci`). Vendored code, models, fonts, and
  media need a hand-written entry in `THIRD_PARTY_NOTICES.md` (or `docs/THIRD_PARTY_AUDIO.md` for
  audio) with source and license. Only add material whose license permits redistribution.

## Security issues

Do not open public issues for vulnerabilities — see [SECURITY.md](SECURITY.md).

## License

Dreambyte is licensed under the [MIT License](../LICENSE). By submitting a contribution you agree
that it is licensed under the same MIT terms ("inbound = outbound"), and that you have the right to
submit it.
