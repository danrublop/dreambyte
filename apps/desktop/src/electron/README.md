# Electron (dev)

Run the editor inside Electron during development:

```bash
npm run dev:desktop    # esbuild watch (main/preload) + renderer watch + Electron
npm run dev:electron   # same, but builds the renderer once instead of watching it
```

Both load the static renderer export from `out/` through the `dreambyte://` protocol
(`DREAMBYTE_FORCE_STATIC=1`). `npm run dev:electron:web` is the legacy flow that points
Electron at `next dev` on `http://localhost:3000` (start `npm run dev` first).
