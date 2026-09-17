# Packaging assets

The one file you need to supply is a **1024×1024 PNG** at `resources/icon-source.png`.
Every other icon artifact below is generated from it automatically by
`npm run build:icons` (wired into `npm run dist:*`).

| File                     | Role                                                             |
| ------------------------ | ---------------------------------------------------------------- |
| `icon-source.png`        | **Input.** You supply this. 1024×1024, PNG.                      |
| `icon.icns`              | Generated. macOS .dmg icon.                                      |
| `icon.ico`               | Generated. Windows .exe icon.                                    |
| `icon.png`               | Generated copy of the 1024×1024 source. Linux AppImage.          |
| `icons/*.png`            | Generated. 16×16 through 1024×1024 PNG set.                      |
| `entitlements.mac.plist` | Checked in. macOS hardened-runtime entitlements.                 |
| `background.png` _(opt)_ | 540×380, DMG install window background. Drop in if you want one. |

A placeholder `icon-source.png` ships with the repo so `npm run dist:dir` works
end-to-end. **Replace it with your real 1024×1024 artwork before cutting a
public release.**

## Regenerating after changing the source

```bash
npm run build:icons
```

This runs `electron-icon-builder` then copies `icon.icns`, `icon.ico`, and
`icon.png` up to `resources/`, which `package.json > build.directories.buildResources` points electron-builder at.
No manual copy needed.

## Notarization (macOS)

Set these env vars before `npm run dist` to produce a Gatekeeper-safe DMG:

- `CSC_LINK` — URL to your Developer ID Application .p12
- `CSC_KEY_PASSWORD` — .p12 password
- `APPLE_ID` — your Apple ID
- `APPLE_APP_SPECIFIC_PASSWORD` — app-specific password from appleid.apple.com
- `APPLE_TEAM_ID` — 10-char team identifier

electron-builder calls `@electron/notarize` automatically if these are present
and the mac target has `hardenedRuntime: true` (see `package.json > build.mac`).

## Windows signing

- `WIN_CSC_LINK` — URL or path to your EV code signing .pfx
- `WIN_CSC_KEY_PASSWORD` — .pfx password
