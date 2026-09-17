import { describe, it, expect } from 'vitest'
import { BUILT_IN_TEMPLATES, INSTANTIABLE_TEMPLATE_IDS, templateHasContent } from './built-in'
import { instantiateTemplate } from './instantiate'
import { USE_TEMPLATE } from '../agents/tools'

/**
 * `use_template` used to accept any of the 30 declared built-in ids and report
 * success for all of them. `tmpl()` defaults `layers` to `[]` and no built-in
 * overrides it, so a template's only possible content is `interactions` — and
 * 20 of the 30 have neither. Those instantiated into a scene with no layers, no
 * code, and empty HTML, which the tool then announced as a created scene.
 */
describe('use_template only offers templates that instantiate', () => {
  it('every offered id produces a scene with actual content', () => {
    expect(INSTANTIABLE_TEMPLATE_IDS.length).toBeGreaterThan(0)
    for (const id of INSTANTIABLE_TEMPLATE_IDS) {
      const t = BUILT_IN_TEMPLATES.find((x) => x.id === id)!
      const scene = instantiateTemplate(t, {}, 'test')
      // interactions is the only content instantiateTemplate carries onto a
      // Scene — template.layers has no field to land in. See templateHasContent.
      expect(scene.interactions?.length ?? 0, `${id} instantiated to an empty scene`).toBeGreaterThan(0)
    }
  })

  it('the schema enum is the derived list, so it cannot drift from the registry', () => {
    const enumIds = (USE_TEMPLATE.input_schema as unknown as { properties: { templateId: { enum?: string[] } } })
      .properties.templateId.enum
    expect(enumIds).toEqual(INSTANTIABLE_TEMPLATE_IDS)
  })

  it('still recognises the hollow templates — they are declared, just not offered', () => {
    const hollow = BUILT_IN_TEMPLATES.filter((t) => !templateHasContent(t))
    // Documents the debt: if someone fills these in, they join the enum for free.
    expect(hollow.length).toBeGreaterThan(0)
    for (const t of hollow) expect(INSTANTIABLE_TEMPLATE_IDS).not.toContain(t.id)
  })
})
