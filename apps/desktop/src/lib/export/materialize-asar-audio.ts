import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * A path is *inside* an asar archive when one of its segments ends in `.asar`
 * (but not `.asar.unpacked`, which is a real on-disk directory). Electron's
 * patched `fs` can read through an asar transparently, but a **native** child
 * process — e.g. the ffmpeg binary the tier3 exporter shells out to —
 * cannot: to the OS, `app.asar` is a single regular file, so `open()` on a path
 * *under* it fails with `ENOTDIR`. Any bundled asset (e.g. the `/sfx-library/`
 * SFX pack, which lives under `getStaticAppDir()` = `app.asar/out` in packaged
 * builds) must therefore be copied out to a real path before FFmpeg sees it.
 */
export function isInsideAsar(p: string): boolean {
  return p.split(path.sep).some((seg) => seg.endsWith('.asar'))
}

/**
 * Ensure `absPath` is a path a native binary (FFmpeg) can open. If it resolves
 * inside an asar archive, copy it out to `tmpDir` via the asar-aware `fs`
 * (`readFile` reads *through* the archive) and return the real temp path. Paths
 * already on the real filesystem — dev builds, user-data dirs, `.asar.unpacked`
 * — pass through untouched, so this is a no-op outside packaged builds.
 *
 * Without this, bundled SFX/audio resolve to an `app.asar/...` path that
 * `fs.access` reports as existing (Electron fs is asar-aware) but that FFmpeg
 * then silently fails to read — dropping the sound from the export with no error.
 */
export async function materializeForFfmpeg(absPath: string, tmpDir: string): Promise<string> {
  if (!isInsideAsar(absPath)) return absPath
  const dest = path.join(tmpDir, `bundled-${randomUUID()}${path.extname(absPath)}`)
  // readFile (not copyFile) — readFile is reliably asar-aware across Electron
  // versions; the source lives inside the archive, the destination does not.
  const buf = await fs.readFile(absPath)
  await fs.writeFile(dest, buf)
  return dest
}
