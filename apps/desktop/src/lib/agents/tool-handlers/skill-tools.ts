/**
 * style_skill — distil the current project's look into a reusable style, apply one
 * wholesale, delete a bad distillation. One tool, one `action` discriminator; it was
 * three tools (distill_style / apply_saved_style / delete_style_skill) over one noun.
 *
 * The runtime DISCOVERY tools (search_skills / load_skill / list_skill_categories)
 * were deleted: selectSkillsForScene already injects the matching library skill into
 * every builder from plan state, and selectProjectStyle auto-applies a matching
 * distilled style — so nothing had to be searched for. Five calls across 36 runs.
 */

import { loadSkill } from '@/lib/skills/registry'
import {
  distillStyle,
  deleteStyleSkill,
  facetsFromSkillGuide,
  facetsToGlobalStylePatch,
  hasAnyFacet,
} from '@/lib/skills/distill'
import { getPreset, STYLE_PRESETS, type StylePresetId } from '@/lib/styles/presets'
import { okGlobal, err, type ToolResult, type WorldStateMutable } from './_shared'

export const SKILL_TOOL_NAMES = ['style_skill'] as const

export function createSkillToolHandler() {
  return async function handleSkillTools(
    _toolName: string,
    args: Record<string, unknown>,
    world?: WorldStateMutable,
  ): Promise<ToolResult> {
    // distill_style / apply_saved_style / delete_style_skill collapsed into one
    // tool with an `action` discriminator. The per-action required args used to be
    // three `required` blocks in three schemas; they are enforced here instead, so
    // an invalid combination still errors honestly rather than no-opping.
    const action = args.action as string | undefined
    switch (action) {
      case 'distill': {
        // Walk the CURRENT project (world scenes + globalStyle) → a reusable
        // 'style' skill. Honest-empty if the project has no distillable signal.
        if (!world) {
          return err('style_skill action "distill" requires an active project context.')
        }
        const { projectId, name, notes } = args as {
          projectId?: string
          name?: string
          notes?: string
        }
        // projectId only drives the id hash (so re-distilling overwrites). Default
        // to the world's project; fall back to a stable label when headless.
        const id = projectId || world.projectId || world.projectName || 'current-project'

        const result = await distillStyle(
          { id, scenes: world.scenes, globalStyle: world.globalStyle },
          { nameHint: name, notes },
        )
        if (!result) {
          return err(
            'Nothing to distil — this project has no scenes or style signal yet. Build some scenes (and optionally set a style/palette or design brief) first, then call style_skill with action "distill".',
          )
        }
        const evictedNote =
          result.evicted.length > 0
            ? ` Evicted ${result.evicted.length} oldest style skill(s) to stay under the cap.`
            : ''
        const enrichmentNote =
          result.enrichment === 'stub' ? ' (description generated deterministically — no model available)' : ''
        return okGlobal(`Distilled style "${result.name}" → skill "${result.id}"${enrichmentNote}.${evictedNote}`, {
          skillId: result.id,
          name: result.name,
          enrichment: result.enrichment,
          evicted: result.evicted,
          hint: 'It is auto-applied to future builds it matches; keep this id to apply or delete it explicitly.',
        })
      }

      case 'delete': {
        const { skillId } = args as { skillId: string }
        if (!skillId) {
          return err('skillId is required for style_skill action "delete".')
        }
        // Refuse to delete curated/built-in skills — distilled style skills only.
        //
        // Edge: loadSkill resolves a curated `library/` skill ahead of a distilled
        // file of the SAME id in the user dir, so a curated id can SHADOW an orphaned
        // distilled file. That file still counts toward the cap-25 + the mtime
        // signature, yet the old guard refused outright → it was unremovable. So even
        // when loadSkill reports curated, we still attempt the user-dir-scoped
        // deleteStyleSkill, which ONLY touches the writable styles dir and therefore
        // can never reach a real curated library file. The refusal only applies when
        // there's no distilled file to clean up.
        const existing = loadSkill(skillId)
        const isCurated = !!existing && existing.metadata.origin !== 'distilled'
        const removed = await deleteStyleSkill(skillId)
        if (!removed) {
          if (isCurated) {
            return err(
              `"${skillId}" is a built-in (curated) skill and cannot be deleted. Only distilled style skills (origin: distilled) can be removed.`,
            )
          }
          return err(`No distilled style skill "${skillId}" found to delete.`)
        }
        // Removed the shadowed distilled copy; the curated id (if any) still resolves.
        return okGlobal(`Deleted distilled style skill "${skillId}".`, {
          skillId,
          deleted: true,
          shadowedCurated: isCurated,
        })
      }

      case 'apply': {
        // The WHOLE-STYLE escape hatch. Fluid per-facet composition is
        // the DEFAULT (the Style Spec block); this is the explicit "use my exact
        // <X> look" override: write a chosen block's visual/motion VALUES straight
        // into GlobalStyle via the same override fields apply_brand_kit/
        // set_global_style hold. Takes EITHER a saved-style skillId OR a presetId.
        if (!world) {
          return err('style_skill action "apply" requires an active project context.')
        }
        const { skillId, presetId } = args as { skillId?: string; presetId?: string }
        if (!skillId && !presetId) {
          return err('Provide either skillId (a saved style) or presetId (a built-in preset) to apply.')
        }

        // ── Preset path: set presetId so resolveStyle uses the whole block. ──
        if (presetId) {
          const id = presetId === 'none' ? null : (presetId as StylePresetId)
          if (id !== null && !(id in STYLE_PRESETS)) {
            return err(
              `Style preset "${presetId}" does not exist. Available presets: ${Object.keys(STYLE_PRESETS).join(', ')}.`,
            )
          }
          const preset = getPreset(id)
          world.globalStyle = {
            ...world.globalStyle,
            presetId: id,
            // Writing the preset's own values as overrides is redundant (resolveStyle
            // reads them off the preset), so the escape hatch for a PRESET is simply
            // pinning presetId and CLEARING any stale per-project overrides so the
            // preset's look applies wholesale — "use the exact <preset> look".
            paletteOverride: null,
            bgColorOverride: null,
            fontOverride: null,
            bodyFontOverride: null,
          }
          return okGlobal(
            id === null
              ? 'Cleared the style preset (neutral baseline) and reset per-project style overrides — applies to new and regenerated scenes; existing scene HTML is unchanged until regenerated.'
              : `Applied preset "${preset.name}" wholesale: presetId set, per-project overrides cleared — applies to new and regenerated scenes; existing scene HTML is unchanged until regenerated.`,
            { globalStyle: world.globalStyle },
          )
        }

        // ── Saved-style path: map its facets → GlobalStyle override fields. ──
        const skill = loadSkill(skillId!)
        if (!skill) {
          return err(`Saved style "${skillId}" not found.`)
        }
        if (skill.metadata.category !== 'style') {
          return err(
            `"${skillId}" is not a saved style (category: ${skill.metadata.category}). style_skill action "apply" only applies category 'style' skills or a presetId.`,
          )
        }
        const facets = facetsFromSkillGuide(skill.guide)
        if (!hasAnyFacet(facets)) {
          return err(
            `Saved style "${skillId}" carries no applicable visual/motion facts to apply. It may be too sparse.`,
          )
        }
        const patch = facetsToGlobalStylePatch(facets)
        const applied = [
          patch.paletteOverride ? 'palette' : null,
          patch.fontOverride ? 'fonts' : null,
          patch.bgColorOverride ? 'background' : null,
          patch.motionPersonality ? 'motion' : null,
          patch.presetId ? `preset "${patch.presetId}"` : null,
        ].filter(Boolean)
        // An empty patch means the style carries only non-mappable facets (renderer
        // / cameraMoves / roughness / a <4-color palette) — none of which set a
        // GlobalStyle field. Writing nothing and reporting "Applied … no fields" is
        // a no-op dressed as success; fail honestly instead. (INFO-8)
        if (applied.length === 0) {
          return err(
            `Saved style "${skill.metadata.name}" has no globally-applicable facets (needs a 4+ color palette, fonts, background, motion, or a preset). Its renderer/camera facts steer per-scene composition, not the global style.`,
          )
        }
        world.globalStyle = {
          ...world.globalStyle,
          ...(patch.presetId !== undefined
            ? { presetId: patch.presetId === 'none' ? null : (patch.presetId as StylePresetId) }
            : {}),
          ...(patch.paletteOverride !== undefined ? { paletteOverride: patch.paletteOverride } : {}),
          ...(patch.fontOverride !== undefined ? { fontOverride: patch.fontOverride } : {}),
          ...(patch.bodyFontOverride !== undefined ? { bodyFontOverride: patch.bodyFontOverride } : {}),
          ...(patch.bgColorOverride !== undefined ? { bgColorOverride: patch.bgColorOverride } : {}),
          ...(patch.motionPersonality !== undefined ? { motionPersonality: patch.motionPersonality } : {}),
        }
        return okGlobal(
          `Applied saved style "${skill.metadata.name}" wholesale: ${applied.join(', ')} — applies to new and regenerated scenes; existing scene HTML is unchanged until regenerated.`,
          { globalStyle: world.globalStyle, applied },
        )
      }

      default:
        return err(`style_skill: unknown action "${action ?? ''}". Must be one of: distill, apply, delete.`)
    }
  }
}
