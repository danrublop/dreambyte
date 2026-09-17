import type { ZdogComposedSceneSpec, ZdogPersonFormula } from '@/lib/types'
import { buildPresetAnimationsCode } from '../animations/presets'
import { createReferenceDemoPersonFromSeed, mergePersonFormula } from '../formulas/person'
import { buildModuleCode } from '../modules'
import { buildPersonRigCode } from '../rigs/person'
import { ZDOG_SCENE } from '../scene-match'
import { buildStudioBlocksCode, personRootVariableName } from '../studio-blocks'

export interface ComposeZdogOptions {
  duration: number
}

export function composeDeterministicZdogScene(spec: ZdogComposedSceneSpec, options: ComposeZdogOptions): string {
  const duration = Math.max(1, options.duration || 8)
  const peopleCode: string[] = []
  const peopleCtx: Record<
    string,
    { handles: ReturnType<typeof buildPersonRigCode>['handles']; formula: ZdogPersonFormula; personId: string }
  > = {}

  for (let i = 0; i < spec.people.length; i += 1) {
    const person = spec.people[i]
    const base = createReferenceDemoPersonFromSeed(spec.seed + i * 101)
    const formula = mergePersonFormula(base, person.formula)
    const rig = buildPersonRigCode(person.id, formula, person.placement)
    const blocks = buildStudioBlocksCode(formula.studioBlocks, personRootVariableName(person.id))
    peopleCode.push(blocks ? `${rig.code}\n${blocks}` : rig.code)
    peopleCtx[person.id] = { handles: rig.handles, formula, personId: person.id }
  }

  const modulesCode = buildModuleCode(spec.modules)
  const beatCode = buildPresetAnimationsCode(spec.beats, peopleCtx)

  return `
const canvas = document.getElementById('zdog-canvas');
const illo = new Zdog.Illustration({
  element: canvas,
  zoom: ${ZDOG_SCENE.illustrationZoom},
  dragRotate: false,
  resize: false,
  width: WIDTH,
  height: HEIGHT,
});
const sceneRoot = new Zdog.Anchor({ addTo: illo });

${modulesCode}

${peopleCode.join('\n\n')}

const sceneState = { t: 0 };
window.__tl.add(sceneState, {
  t: [0, ${duration}],
  duration: ${duration},
  ease: 'linear',
  onUpdate: function() {
    const t = sceneState.t;
    sceneRoot.rotate.y = Math.sin(t * 0.25) * 0.22;
    ${beatCode}
    illo.updateRenderGraph();
  },
}, 0);

illo.updateRenderGraph();
`
}
