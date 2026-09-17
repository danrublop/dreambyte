import type { ZdogAnimationPreset, ZdogBeat, ZdogPersonFormula } from '@/lib/types'
import type { ZdogPersonRigHandles } from '../rigs/person'

interface ClipContext {
  personId: string
  handles: ZdogPersonRigHandles
  formula: ZdogPersonFormula
}

function animCall(beat: ZdogBeat, body: string): string {
  // `beat` comes from AI tool-call args (create_zdog_composed_scene) with only
  // Array.isArray validation upstream, so `at`/`duration` may be missing or
  // non-numeric. Coerce before interpolating into generated JS, else a NaN
  // `at` yields an always-false guard and the beat silently never fires
  const at = Number.isFinite(beat.at) ? beat.at : 0
  const dur = Number.isFinite(beat.duration) ? (beat.duration as number) : 1.2
  return `if (t >= ${at} && t <= ${at + dur}) { const local = (t - ${at}) / ${Math.max(dur, 0.001)}; ${body} }`
}

function presetCode(preset: ZdogAnimationPreset, beat: ZdogBeat, ctx: ClipContext): string {
  const amp = ctx.formula.motionProfile.idleAmplitude.toFixed(3)
  const gesture = ctx.formula.motionProfile.gestureBias.toFixed(3)
  const walk = ctx.formula.motionProfile.walkAmplitude.toFixed(3)
  const h = ctx.handles
  switch (preset) {
    case 'idleBreath':
      return animCall(
        beat,
        `if (${h.spine}._baseY === undefined) ${h.spine}._baseY = ${h.spine}.translate.y || 0; ${h.spine}.translate.y = ${h.spine}._baseY + Math.sin(local * Math.PI * 2) * 0.45 * ${amp};`,
      )
    case 'talkNod':
      return animCall(
        beat,
        `${h.head}.rotate.x = Math.sin(local * Math.PI * 4) * 0.2 * ${gesture}; ${h.rightForearm}.rotate.x = 0.2 + Math.sin(local * Math.PI * 4) * 0.05;`,
      )
    case 'wave':
      return animCall(
        beat,
        `${h.rightUpperArm}.rotate.z = -0.4; ${h.rightForearm}.rotate.x = -0.7 + Math.sin(local * Math.PI * 6) * 0.9 * ${gesture};`,
      )
    case 'pointLeft':
      return animCall(
        beat,
        `${h.leftUpperArm}.rotate.z = 1.1; ${h.leftForearm}.rotate.x = -0.9; ${h.leftForearm}.rotate.z = 0.15;`,
      )
    case 'pointRight':
      return animCall(
        beat,
        `${h.rightUpperArm}.rotate.z = -1.1; ${h.rightForearm}.rotate.x = -0.9; ${h.rightForearm}.rotate.z = -0.15;`,
      )
    case 'present':
      return animCall(
        beat,
        `${h.leftUpperArm}.rotate.z = 0.6; ${h.rightUpperArm}.rotate.z = -0.6; ${h.leftForearm}.rotate.x = -0.4; ${h.rightForearm}.rotate.x = -0.4;`,
      )
    case 'walkInPlace':
      return animCall(
        beat,
        `if (${h.hips}._baseY === undefined) ${h.hips}._baseY = ${h.hips}.translate.y || 0; ${h.leftUpperLeg}.rotate.x = Math.sin(local * Math.PI * 4) * 0.5 * ${walk}; ${h.rightUpperLeg}.rotate.x = Math.sin(local * Math.PI * 4 + Math.PI) * 0.5 * ${walk}; ${h.hips}.translate.y = ${h.hips}._baseY + Math.sin(local * Math.PI * 8) * 0.2;`,
      )
    default:
      return ''
  }
}

export function buildPresetAnimationsCode(beats: ZdogBeat[], personRefs: Record<string, ClipContext>): string {
  const snippets: string[] = []
  for (const beat of beats) {
    const ctx = personRefs[beat.targetPersonId]
    if (!ctx) continue
    snippets.push(presetCode(beat.action, beat, ctx))
  }
  return snippets.join('\n')
}
