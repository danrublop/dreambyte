import type { IpcMain } from 'electron'
import { listCharacters } from '@/lib/db/queries/characters'
import { reuseCharacter, CharacterError } from '@/lib/services/characters'
import { assertValidUuid, IpcValidationError } from './_helpers'

/**
 * Category: characters
 *
 * Renderer access to the project's character bundles for the Cinema Studio panel:
 *   - characters.list  → the project's characters, for the picker
 *   - characters.reuse → render a character into a new image (i2i), gated by spend caps
 *
 * reuse FORCES `skipPermissionGate: false` so the renderer can NEVER bypass reuseCharacter's spend
 * gate — only the in-process agent tool handler (which runs its own permission UX) may skip, and
 * it does not go through this channel. A CharacterError (incl. a spend-cap deny, dangling
 * reference, or no i2i provider) is returned as `{ error }` so the panel can show it as a failed
 * layer rather than throwing an unhandled rejection at the renderer.
 */

async function list(projectId: string) {
  assertValidUuid(projectId, 'projectId')
  return { characters: await listCharacters(projectId) }
}

interface ReuseArgs {
  projectId: string
  character: string
  prompt: string
  negativePrompt?: string
  aspectRatio?: string
  mediaGenEnabled?: Record<string, boolean> | null
  approvedAsk?: boolean
}

async function reuse(args: ReuseArgs) {
  assertValidUuid(args.projectId, 'projectId')
  if (!args.character || typeof args.character !== 'string') throw new IpcValidationError('character is required')
  if (!args.prompt || typeof args.prompt !== 'string') throw new IpcValidationError('prompt is required')
  try {
    const result = await reuseCharacter({
      projectId: args.projectId,
      character: args.character,
      prompt: args.prompt,
      negativePrompt: args.negativePrompt,
      aspectRatio: args.aspectRatio,
      mediaGenEnabled: args.mediaGenEnabled ?? null,
      // Renderer path: NEVER skip the spend gate.
      skipPermissionGate: false,
      // approvedAsk only satisfies an always-ask prompt the user accepted; it can never bypass a
      // 'deny', so it's safe to honor from the renderer (mirrors the generate.* IPC boundary).
      approvedAsk: args.approvedAsk,
    })
    // Always-ask gate: surface permissionNeeded so the panel pops the modal, then re-dispatches.
    if ('permissionNeeded' in result) return { permissionNeeded: result.permissionNeeded }
    return {
      assetId: result.asset.id,
      imageUrl: result.asset.publicUrl,
      characterId: result.characterId,
      cost: result.cost,
      finalPrompt: result.finalPrompt,
    }
  } catch (err) {
    if (err instanceof CharacterError) return { error: err.message }
    throw err
  }
}

export function register(ipcMain: IpcMain): void {
  ipcMain.handle('dreambyte:characters.list', (_e, projectId: string) => list(projectId))
  ipcMain.handle('dreambyte:characters.reuse', (_e, args: ReuseArgs) => reuse(args))
}
