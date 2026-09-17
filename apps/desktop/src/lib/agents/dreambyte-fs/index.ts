// Public surface for the scoped Tier 2 filesystem (W7).
//
// External agents (Claude Code, Cursor, Codex) use these tools to read
// a Dreambyte project's `.dreambyte/` folder safely. Every operation goes
// through the path guard before touching disk.

export { PathEscapeError, PathNotFoundError, safeResolve, assertContained, isWithin } from './path-guard'
export {
  DreambyteFsError,
  listScenes,
  readProject,
  readScene,
  readSceneHtml,
  listAssets,
  type SceneSummary,
  type AssetEntry,
} from './tools'
