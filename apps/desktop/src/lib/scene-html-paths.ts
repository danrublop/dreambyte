import path from 'path'

/**
 * Resolve where generated scene HTML should be written.
 *
 * Dev: `<repo>/public/scenes` so Next can serve hot scene previews.
 * Desktop: Electron stamps `DREAMBYTE_SCENES_DIR` to `<userData>/scenes` because
 * packaged app resources are not a writable runtime scene store.
 */
export function resolveScenesDir(): string {
  const override = process.env.DREAMBYTE_SCENES_DIR
  if (override) return override
  return path.join(process.cwd(), 'public', 'scenes')
}
