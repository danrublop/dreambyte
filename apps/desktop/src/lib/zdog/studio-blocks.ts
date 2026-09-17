import type { ZdogStudioBlock } from '@/lib/types'

function safeJsId(input: string): string {
  const cleaned = input.replace(/[^a-zA-Z0-9_]/g, '_')
  if (!cleaned) return 'id'
  return /^[0-9]/.test(cleaned) ? `id_${cleaned}` : cleaned
}

/** Matches `person_${safeJsId(personId)}_root` from buildPersonRigCode. */
export function personRootVariableName(personId: string): string {
  return `person_${safeJsId(personId)}_root`
}

function q(s: string): string {
  return JSON.stringify(s)
}

/**
 * Emits Zdog constructors parented to the person root (after rig code).
 */
export function buildStudioBlocksCode(blocks: ZdogStudioBlock[] | undefined, attachToRootVar: string): string {
  if (!blocks?.length) return ''
  const parts: string[] = []
  for (const b of blocks) {
    const c = q(b.color)
    const tx = b.x
    const ty = b.y
    const tz = b.z
    const rx = b.rotateX
    const ry = b.rotateY
    const rz = b.rotateZ
    if (b.kind === 'box') {
      const w = Math.max(0.25, b.w)
      const h = Math.max(0.25, b.h)
      const d = Math.max(0.25, b.d)
      parts.push(`new Zdog.Box({
  addTo: ${attachToRootVar},
  width: ${w},
  height: ${h},
  depth: ${d},
  translate: { x: ${tx}, y: ${ty}, z: ${tz} },
  rotate: { x: ${rx}, y: ${ry}, z: ${rz} },
  stroke: false,
  color: ${c},
});`)
    } else if (b.kind === 'sphere') {
      const stroke = Math.max(0.5, b.w)
      parts.push(`new Zdog.Shape({
  addTo: ${attachToRootVar},
  stroke: ${stroke},
  translate: { x: ${tx}, y: ${ty}, z: ${tz} },
  rotate: { x: ${rx}, y: ${ry}, z: ${rz} },
  color: ${c},
});`)
    } else {
      const diam = Math.max(0.5, b.w)
      const length = Math.max(0.5, b.d)
      const str = Math.max(0.5, b.stroke ?? 2.5)
      parts.push(`new Zdog.Cylinder({
  addTo: ${attachToRootVar},
  diameter: ${diam},
  length: ${length},
  stroke: ${str},
  translate: { x: ${tx}, y: ${ty}, z: ${tz} },
  rotate: { x: ${rx}, y: ${ry}, z: ${rz} },
  color: ${c},
});`)
    }
  }
  return parts.join('\n')
}
