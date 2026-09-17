import type { ZdogPersonFormula, ZdogPersonPlacement } from '@/lib/types'

export interface ZdogPersonRigHandles {
  root: string
  spine: string
  head: string
  leftUpperArm: string
  leftForearm: string
  rightUpperArm: string
  rightForearm: string
  hips: string
  leftUpperLeg: string
  rightUpperLeg: string
}

export interface ZdogPersonRigBuild {
  code: string
  handles: ZdogPersonRigHandles
}

function safeJsId(input: string): string {
  const cleaned = input.replace(/[^a-zA-Z0-9_]/g, '_')
  if (!cleaned) return 'id'
  return /^[0-9]/.test(cleaned) ? `id_${cleaned}` : cleaned
}

function q(v: string): string {
  return JSON.stringify(v)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * Compact Zdog person (reference: zdog_person_hair_fix2.html).
 * hips → spine Anchor → chest Shape → head + arms; legs on hips.
 * Same handle names as the legacy rig so preset beats keep working.
 */
export function buildPersonRigCode(
  personId: string,
  formula: ZdogPersonFormula,
  placement: ZdogPersonPlacement,
): ZdogPersonRigBuild {
  const p = formula.proportions
  const pal = formula.palette
  const id = safeJsId(personId)
  const root = `person_${id}_root`
  const spine = `person_${id}_spine`
  const head = `person_${id}_head`
  const lUpper = `person_${id}_lUpperArm`
  const lFore = `person_${id}_lForearm`
  const rUpper = `person_${id}_rUpperArm`
  const rFore = `person_${id}_rForearm`
  const hips = `person_${id}_hips`
  const lLeg = `person_${id}_lLeg`
  const rLeg = `person_${id}_rLeg`

  const accessories = new Set(formula.accessories)
  const body = formula.bodyStyle ?? {
    torsoWidth: 2.2,
    armThickness: 4.85,
    legThickness: 5.0,
    hipWidth: 2.8,
  }

  /** Scale HTML reference (head stroke 12) to formula head size. */
  const k = p.head / 12
  const bdRaw = formula.bodyDepth ?? { hipsZ: 0, spineZ: 0 }
  const bd = { hipsZ: clamp(bdRaw.hipsZ, -10, 10), spineZ: clamp(bdRaw.spineZ, -10, 10) }

  const hipHalf = 3 * k * (body.hipWidth / 2.8)
  const chestHalf = 1.5 * k * (body.torsoWidth / 2.2)
  const hipLineStroke = Math.max(2.2, 4 * k * (body.legThickness / 5))
  const chestStroke = Math.max(5, 9 * k * (body.torsoWidth / 2.2))
  const thighLen = Math.max(3, k * p.upperLeg)
  const shinLen = Math.max(3, k * p.lowerLeg)
  const armUpperLen = Math.max(3, k * p.upperArm)
  const armForeLen = Math.max(2.5, k * p.forearm)
  const hipX = Math.max(2, hipHalf * 0.95)
  const legStroke = Math.max(2.5, 4 * k * (body.legThickness / 5))
  const shinStroke = Math.max(2.2, 3.5 * k * (body.legThickness / 5))
  const armStroke = Math.max(2.5, 4 * k * (body.armThickness / 4.85))
  const handStroke = Math.max(4, 6 * k * (body.armThickness / 4.85))
  const footW = Math.max(1.5, 2 * k)
  const footH = Math.max(3, 4 * k)
  const footStroke = Math.max(2.5, 4 * k)

  const chestY = -6.5 * k
  const headY = -9.5 * k
  const armAttachY = -2 * k
  const armSideX = 5 * k * (body.torsoWidth / 2.2)
  const hipsBaseY = 2 * k

  const hp = formula.headProfile ?? { offsetX: 0, offsetY: 0, offsetZ: 0, rotateY: 0 }
  // Reference demo rotates the whole illustration (y: -TAU/8), not the head node.
  const headYaw = (hp.rotateY ?? 0).toFixed(3)
  const headRotX = (hp.rotateX ?? 0).toFixed(3)
  const headRotZ = (hp.rotateZ ?? 0).toFixed(3)
  const hox = hp.offsetX.toFixed(2)
  const hoy = hp.offsetY.toFixed(2)
  const hoz = hp.offsetZ.toFixed(2)

  const hair = formula.hairProfile ?? {
    size: 1.05,
    rotateX: 0,
    rotateY: 0,
    rotateZ: 0,
    offsetX: 0,
    offsetY: 3.52,
    offsetZ: 0,
  }
  const hairVisualSize = clamp(hair.size, 0.35, 5.5) * 1.02
  const hairOffsetX = clamp(hair.offsetX, -6, 6)
  const hairOffsetY = clamp(hair.offsetY, -12, 12)
  const hairOffsetZ = clamp(hair.offsetZ, -6, 6)
  const hairBaseY = -p.head * 0.29

  const face = formula.faceProfile ?? { eyesY: 0, noseY: 0, mouthY: 0, depthZ: 0 }
  const eyeXOff = clamp(face.eyesX ?? 0, -5, 5)
  // Reference demo (head stroke 12): eye z≈4.5, y≈1, mouth y≈2.5 — same units scaled by k.
  const faceDepth = clamp(face.depthZ, -4, 4)
  const eyeZ = (4.5 * k + faceDepth + clamp(face.eyesZ ?? 0, -4, 4)).toFixed(2)
  const mouthZ = (4.5 * k + faceDepth + clamp(face.mouthZ ?? 0, -4, 4)).toFixed(2)
  const noseZ = (4.5 * k + faceDepth + clamp(face.noseZ ?? 0, -4, 4)).toFixed(2)
  const eyeY = ((formula.faceStyle === 'serious' ? 0.67 : 1) + clamp(face.eyesY, -4, 4) * 0.12) * k
  const mouthY = (2.5 + clamp(face.mouthY, -4, 4) * 0.12) * k
  const noseY = (1.5 + clamp(face.noseY, -4, 4) * 0.12) * k
  const noseXNum = clamp(face.noseX ?? 0, -3, 3)
  const mouthXNum = clamp(face.mouthX ?? 0, -3, 3)
  const leftEyeX = (-2 + eyeXOff) * k
  const rightEyeX = (2 + eyeXOff) * k

  const eyeStyle = formula.eyeStyle ?? 'almond'
  const mouthStyle = formula.mouthStyle ?? 'smile'
  const noseStyle = formula.noseStyle ?? 'line'
  const eyeDiam = (eyeStyle === 'wide' ? 2.72 : 2.2) * k
  const eyeStrokeW = (eyeStyle === 'wide' ? 0.88 : 0.72) * Math.max(0.85, k)

  const leftEye =
    eyeStyle === 'dot'
      ? `new Zdog.Shape({ addTo: ${head}, stroke: ${(0.85 * k).toFixed(2)}, color: '#111827', translate: { x: ${leftEyeX.toFixed(2)}, y: ${eyeY}, z: ${eyeZ} }, backface: false });`
      : `new Zdog.Ellipse({ addTo: ${head}, diameter: ${eyeDiam.toFixed(2)}, quarters: 2, translate: { x: ${leftEyeX.toFixed(2)}, y: ${eyeY}, z: ${eyeZ} }, rotate: { z: -Zdog.TAU/4 }, color: '#1f2937', stroke: ${eyeStrokeW.toFixed(2)}, backface: false });`
  const rightEye =
    eyeStyle === 'dot'
      ? `new Zdog.Shape({ addTo: ${head}, stroke: ${(0.85 * k).toFixed(2)}, color: '#111827', translate: { x: ${rightEyeX.toFixed(2)}, y: ${eyeY}, z: ${eyeZ} }, backface: false });`
      : `new Zdog.Ellipse({ addTo: ${head}, diameter: ${eyeDiam.toFixed(2)}, quarters: 2, translate: { x: ${rightEyeX.toFixed(2)}, y: ${eyeY}, z: ${eyeZ} }, rotate: { z: -Zdog.TAU/4 }, color: '#1f2937', stroke: ${eyeStrokeW.toFixed(2)}, backface: false });`

  const mouth =
    mouthStyle === 'neutral'
      ? `new Zdog.Shape({ addTo: ${head}, path: [{ x: ${(-1.1 * k + mouthXNum).toFixed(2)}, y: ${mouthY}, z: ${mouthZ} }, { x: ${(1.1 * k + mouthXNum).toFixed(2)}, y: ${mouthY}, z: ${mouthZ} }], stroke: ${(0.5 * k).toFixed(2)}, color: '#ffffff', backface: false });`
      : `new Zdog.Ellipse({ addTo: ${head}, diameter: ${((mouthStyle === 'grin' ? 3.6 : 3) * k).toFixed(2)}, quarters: 2, translate: { x: ${mouthXNum.toFixed(2)}, y: ${mouthY}, z: ${mouthZ} }, rotate: { z: Zdog.TAU/4 }, closed: true, color: '#ffffff', stroke: ${((mouthStyle === 'grin' ? 0.7 : 0.5) * k).toFixed(2)}, fill: true, backface: false });`

  const nose =
    noseStyle === 'dot'
      ? `new Zdog.Shape({ addTo: ${head}, stroke: ${(0.5 * k).toFixed(2)}, color: '#b08968', translate: { x: ${noseXNum.toFixed(2)}, y: ${noseY}, z: ${noseZ} }, backface: false });`
      : noseStyle === 'button'
        ? `new Zdog.Ellipse({ addTo: ${head}, diameter: ${(0.9 * k).toFixed(2)}, stroke: ${(0.2 * k).toFixed(2)}, color: '#b08968', fill: true, translate: { x: ${noseXNum.toFixed(2)}, y: ${noseY}, z: ${noseZ} }, backface: false });`
        : `new Zdog.Shape({ addTo: ${head}, path: [{ x: ${noseXNum.toFixed(2)}, y: ${(noseY - 0.5 * k).toFixed(2)}, z: ${noseZ} }, { x: ${noseXNum.toFixed(2)}, y: ${(noseY + 0.25 * k).toFixed(2)}, z: ${noseZ} }], stroke: ${(0.35 * k).toFixed(2)}, color: '#b08968', backface: false });`

  const hairCode = (() => {
    if (formula.hairStyle === 'curls') {
      const curlD = 5 * k * hairVisualSize
      const hc = q(pal.hair)
      const curls: [number, number, number][] = [
        [0, -7, 0],
        [-2.5, -6.5, 1.5],
        [2.5, -6.5, 1.5],
        [-1.5, -6.5, -1.5],
        [1.5, -6.5, -1.5],
        [0, -6, 3],
        [-3, -6, 0],
        [3, -6, 0],
        [0, -6, -3],
      ]
      // Match reference HTML: curl translates are head-local only (no hairBaseY — that
      // was for the old dome-on-sphere rig and floats curls far above the compact head).
      return curls
        .map(([cx, cy, cz]) => {
          const tx = cx * k + hairOffsetX
          const ty = cy * k + hairOffsetY
          const tz = cz * k + hairOffsetZ
          return `new Zdog.Hemisphere({
  addTo: ${head},
  diameter: ${curlD.toFixed(2)},
  stroke: false,
  color: ${hc},
  backface: ${hc},
  translate: { x: ${tx.toFixed(2)}, y: ${ty.toFixed(2)}, z: ${tz.toFixed(2)} },
  rotate: { x: Zdog.TAU/2 },
});`
        })
        .join('\n')
    }
    const domeD = p.head * 0.95 * hairVisualSize
    const TAU = Math.PI * 2
    const rx = (TAU / 4 - 0.06 + clamp(hair.rotateX, -1.2, 1.2)).toFixed(3)
    const ry = clamp(hair.rotateY, -1.2, 1.2).toFixed(3)
    const rz = clamp(hair.rotateZ, -1.2, 1.2).toFixed(3)
    return `new Zdog.Hemisphere({
  addTo: ${head},
  diameter: ${domeD.toFixed(2)},
  stroke: ${(0.45 * k).toFixed(2)},
  color: ${q(pal.hair)},
  translate: { x: ${hairOffsetX.toFixed(2)}, y: ${(hairBaseY + hairOffsetY).toFixed(2)}, z: ${hairOffsetZ.toFixed(2)} },
  rotate: { x: ${rx}, y: ${ry}, z: ${rz} },
  backface: ${q(pal.hair)},
});`
  })()

  // Coerce placement to finite numbers before interpolating into generated JS —
  // a NaN/undefined coordinate (from unvalidated AI tool args) would emit
  // `translate: { x: NaN }`, silently breaking the rig. Mirrors the
  // toFixed pattern used for the body measurements below.
  const num = (v: unknown, fallback: number) => (Number.isFinite(v) ? (v as number) : fallback)
  const px = num(placement.x, 0).toFixed(2)
  const py = num(placement.y, 0).toFixed(2)
  const pz = num(placement.z, 0).toFixed(2)
  const pRotY = num(placement.rotationY, 0).toFixed(3)
  const pScale = num(placement.scale, 1).toFixed(3)
  const code = `
// Person rig ${id} (compact): hips → spine → chest → head/arms; legs on hips.
const ${root} = new Zdog.Anchor({
  addTo: sceneRoot,
  translate: { x: ${px}, y: ${py}, z: ${pz} },
  rotate: { y: ${pRotY} },
  scale: ${pScale},
});

const ${hips} = new Zdog.Anchor({
  addTo: ${root},
  translate: { y: ${hipsBaseY.toFixed(2)}, z: ${bd.hipsZ.toFixed(2)} },
});
new Zdog.Shape({
  addTo: ${hips},
  path: [{ x: -${hipHalf.toFixed(2)} }, { x: ${hipHalf.toFixed(2)} }],
  stroke: ${hipLineStroke.toFixed(2)},
  color: ${q(pal.bottom)},
});

const ${spine} = new Zdog.Anchor({
  addTo: ${hips},
  translate: { z: ${bd.spineZ.toFixed(2)} },
});

const person_${id}_chest = new Zdog.Shape({
  addTo: ${spine},
  path: [{ x: -${chestHalf.toFixed(2)} }, { x: ${chestHalf.toFixed(2)} }],
  translate: { y: ${chestY.toFixed(2)} },
  stroke: ${chestStroke.toFixed(2)},
  color: ${q(pal.top)},
});

const person_${id}_headAnchor = new Zdog.Anchor({
  addTo: person_${id}_chest,
  translate: { x: ${hox}, y: ${(headY + hp.offsetY).toFixed(2)}, z: ${hoz} },
  rotate: { x: ${headRotX}, y: ${headYaw}, z: ${headRotZ} },
});
const ${head} = new Zdog.Shape({
  addTo: person_${id}_headAnchor,
  stroke: ${p.head.toFixed(2)},
  color: ${q(pal.skin)},
});
${leftEye}
${rightEye}
${mouth}
${nose}
${hairCode}
${
  accessories.has('glasses')
    ? `new Zdog.Ellipse({ addTo: ${head}, diameter: ${(4 * k).toFixed(2)}, stroke: ${(0.5 * k).toFixed(2)}, color: '#111827', translate: { x: ${leftEyeX.toFixed(2)}, y: ${Number(eyeY).toFixed(2)}, z: ${eyeZ} }, fill: false, backface: false });
new Zdog.Ellipse({ addTo: ${head}, diameter: ${(4 * k).toFixed(2)}, stroke: ${(0.5 * k).toFixed(2)}, color: '#111827', translate: { x: ${rightEyeX.toFixed(2)}, y: ${Number(eyeY).toFixed(2)}, z: ${eyeZ} }, fill: false, backface: false });`
    : ''
}

const ${lUpper} = new Zdog.Shape({
  addTo: person_${id}_chest,
  path: [{ y: 0 }, { y: ${armUpperLen.toFixed(2)} }],
  translate: { x: -${armSideX.toFixed(2)}, y: ${armAttachY.toFixed(2)} },
  stroke: ${armStroke.toFixed(2)},
  color: ${q(pal.top)},
});
const ${lFore} = new Zdog.Shape({
  addTo: ${lUpper},
  path: [{ y: 0 }, { y: ${armForeLen.toFixed(2)} }],
  translate: { y: ${armUpperLen.toFixed(2)} },
  stroke: ${armStroke.toFixed(2)},
  color: ${q(pal.skin)},
});
new Zdog.Shape({
  addTo: ${lFore},
  stroke: ${handStroke.toFixed(2)},
  color: ${q(pal.skin)},
  translate: { y: ${(armForeLen + handStroke * 0.35).toFixed(2)}, z: ${(1 * k).toFixed(2)} },
});

const ${rUpper} = new Zdog.Shape({
  addTo: person_${id}_chest,
  path: [{ y: 0 }, { y: ${armUpperLen.toFixed(2)} }],
  translate: { x: ${armSideX.toFixed(2)}, y: ${armAttachY.toFixed(2)} },
  stroke: ${armStroke.toFixed(2)},
  color: ${q(pal.top)},
});
const ${rFore} = new Zdog.Shape({
  addTo: ${rUpper},
  path: [{ y: 0 }, { y: ${armForeLen.toFixed(2)} }],
  translate: { y: ${armUpperLen.toFixed(2)} },
  stroke: ${armStroke.toFixed(2)},
  color: ${q(pal.skin)},
});
new Zdog.Shape({
  addTo: ${rFore},
  stroke: ${handStroke.toFixed(2)},
  color: ${q(pal.skin)},
  translate: { y: ${(armForeLen + handStroke * 0.35).toFixed(2)}, z: ${(1 * k).toFixed(2)} },
});

const ${lLeg} = new Zdog.Anchor({ addTo: ${hips}, translate: { x: -${hipX.toFixed(2)} } });
new Zdog.Shape({
  addTo: ${lLeg},
  path: [{ y: 0 }, { y: ${thighLen.toFixed(2)} }],
  stroke: ${legStroke.toFixed(2)},
  color: ${q(pal.bottom)},
});
const person_${id}_lShin = new Zdog.Anchor({ addTo: ${lLeg}, translate: { y: ${thighLen.toFixed(2)} } });
new Zdog.Shape({
  addTo: person_${id}_lShin,
  path: [{ y: 0 }, { y: ${shinLen.toFixed(2)} }],
  stroke: ${shinStroke.toFixed(2)},
  color: ${q(pal.bottom)},
});
new Zdog.RoundedRect({
  addTo: person_${id}_lShin,
  width: ${footW.toFixed(2)},
  height: ${footH.toFixed(2)},
  cornerRadius: 1,
  translate: { y: ${(shinLen + footH * 0.5).toFixed(2)}, z: ${(2 * k).toFixed(2)} },
  rotate: { x: Zdog.TAU/4 },
  color: ${q(pal.accent)},
  fill: true,
  stroke: ${footStroke.toFixed(2)},
});

const ${rLeg} = new Zdog.Anchor({ addTo: ${hips}, translate: { x: ${hipX.toFixed(2)} } });
new Zdog.Shape({
  addTo: ${rLeg},
  path: [{ y: 0 }, { y: ${thighLen.toFixed(2)} }],
  stroke: ${legStroke.toFixed(2)},
  color: ${q(pal.bottom)},
});
const person_${id}_rShin = new Zdog.Anchor({ addTo: ${rLeg}, translate: { y: ${thighLen.toFixed(2)} } });
new Zdog.Shape({
  addTo: person_${id}_rShin,
  path: [{ y: 0 }, { y: ${shinLen.toFixed(2)} }],
  stroke: ${shinStroke.toFixed(2)},
  color: ${q(pal.bottom)},
});
new Zdog.RoundedRect({
  addTo: person_${id}_rShin,
  width: ${footW.toFixed(2)},
  height: ${footH.toFixed(2)},
  cornerRadius: 1,
  translate: { y: ${(shinLen + footH * 0.5).toFixed(2)}, z: ${(2 * k).toFixed(2)} },
  rotate: { x: Zdog.TAU/4 },
  color: ${q(pal.accent)},
  fill: true,
  stroke: ${footStroke.toFixed(2)},
});

${accessories.has('badge') ? `new Zdog.Rect({ addTo: ${spine}, width: ${(2.4 * k).toFixed(2)}, height: ${(2.8 * k).toFixed(2)}, stroke: ${(0.8 * k).toFixed(2)}, color: ${q(pal.accent)}, fill: true, translate: { x: ${(1.8 * k).toFixed(2)}, y: ${(chestY - 1.5 * k).toFixed(2)}, z: ${(2.2 * k).toFixed(2)} } });` : ''}
${accessories.has('tablet') ? `new Zdog.RoundedRect({ addTo: ${rFore}, width: ${(2.6 * k).toFixed(2)}, height: ${(3.6 * k).toFixed(2)}, cornerRadius: ${(0.4 * k).toFixed(2)}, stroke: ${(0.8 * k).toFixed(2)}, color: '#111827', fill: true, translate: { y: ${(armForeLen + 1.4 * k).toFixed(2)}, z: ${(2.2 * k).toFixed(2)} }, rotate: { x: -0.25, y: -0.2 } });` : ''}
`

  return {
    code,
    handles: {
      root,
      spine,
      head,
      leftUpperArm: lUpper,
      leftForearm: lFore,
      rightUpperArm: rUpper,
      rightForearm: rFore,
      hips,
      leftUpperLeg: lLeg,
      rightUpperLeg: rLeg,
    },
  }
}
