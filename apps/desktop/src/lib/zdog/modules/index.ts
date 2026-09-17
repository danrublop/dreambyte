import type { ZdogModuleConfig } from '@/lib/types'

function q(v: string): string {
  return JSON.stringify(v)
}

function colorExpr(color?: string, fallback: string = 'PALETTE[0]'): string {
  if (!color) return fallback
  return color.startsWith('#') ? q(color) : color
}

function safeJsId(input: string): string {
  const cleaned = input.replace(/[^a-zA-Z0-9_]/g, '_')
  if (!cleaned) return 'id'
  return /^[0-9]/.test(cleaned) ? `id_${cleaned}` : cleaned
}

function buildBarChart(mod: ZdogModuleConfig): string {
  const data = mod.data && mod.data.length ? mod.data : [3, 5, 4, 7]
  const color = colorExpr(mod.color, 'PALETTE[3]')
  const bars = data
    .map((v, i) => {
      const h = Math.max(2, v * 2.2)
      return `new Zdog.Box({ addTo: module_${mod.id}, width: 3.2, depth: 3.2, height: ${h.toFixed(
        2,
      )}, stroke: 0.6, color: ${color}, topFace: ${color}, leftFace: ${color}, rightFace: ${color}, translate: { x: ${(
        -6 +
        i * 4
      ).toFixed(2)}, y: ${(-h / 2).toFixed(2)}, z: 0 } });`
    })
    .join('\n')
  return `${bars}
new Zdog.Rect({ addTo: module_${mod.id}, width: 20, height: 1.2, stroke: 0.5, color: '#334155', fill: true, translate: { x: 0, y: 1.4, z: -2 } });`
}

function buildLineChart(mod: ZdogModuleConfig): string {
  const data = mod.data && mod.data.length ? mod.data : [2, 4, 3, 6, 5]
  const path = data.map((v, i) => `{ x: ${(-8 + i * 4).toFixed(2)}, y: ${(-v * 1.7).toFixed(2)}, z: 0 }`).join(', ')
  return `new Zdog.Shape({ addTo: module_${mod.id}, path: [${path}], closed: false, stroke: 1.1, color: ${colorExpr(
    mod.color,
    'PALETTE[2]',
  )} });
new Zdog.Rect({ addTo: module_${mod.id}, width: 20, height: 1.2, stroke: 0.5, color: '#334155', fill: true, translate: { x: 0, y: 1.4, z: -2 } });`
}

function buildDonutChart(mod: ZdogModuleConfig): string {
  const color = colorExpr(mod.color, 'PALETTE[1]')
  return `new Zdog.Ellipse({ addTo: module_${mod.id}, diameter: 12, stroke: 3.5, color: ${color}, fill: false, rotate: { x: Zdog.TAU / 4 } });
new Zdog.Ellipse({ addTo: module_${mod.id}, diameter: 5.2, stroke: 3.4, color: '#fffef9', fill: true, rotate: { x: Zdog.TAU / 4 }, translate: { z: 0.2 } });`
}

function buildPresentationBoard(mod: ZdogModuleConfig): string {
  return `new Zdog.RoundedRect({ addTo: module_${mod.id}, width: 22, height: 14, cornerRadius: 1.2, stroke: 1.2, color: '#0f172a', fill: true, translate: { z: -1.5 } });
new Zdog.RoundedRect({ addTo: module_${mod.id}, width: 20, height: 12, cornerRadius: 1, stroke: 0.9, color: '#e2e8f0', fill: true, translate: { z: -0.4 } });`
}

function buildDesk(mod: ZdogModuleConfig): string {
  return `new Zdog.Box({ addTo: module_${mod.id}, width: 20, height: 2, depth: 10, stroke: 0.8, color: '#8b5e3c', fill: true, translate: { y: 1, z: 0 } });
new Zdog.Shape({ addTo: module_${mod.id}, path: [{ x: -8, y: 1, z: -3 }, { x: -8, y: 8, z: -3 }], stroke: 1, color: '#7c4a2e' });
new Zdog.Shape({ addTo: module_${mod.id}, path: [{ x: 8, y: 1, z: -3 }, { x: 8, y: 8, z: -3 }], stroke: 1, color: '#7c4a2e' });`
}

function buildTablet(mod: ZdogModuleConfig): string {
  return `new Zdog.RoundedRect({ addTo: module_${mod.id}, width: 8, height: 11, cornerRadius: 0.8, stroke: 0.9, color: '#111827', fill: true });
new Zdog.RoundedRect({ addTo: module_${mod.id}, width: 6.8, height: 9.3, cornerRadius: 0.5, stroke: 0.5, color: '#93c5fd', fill: true, translate: { z: 0.4 } });`
}

export function buildModuleCode(modules: ZdogModuleConfig[]): string {
  return modules
    .map((mod) => {
      const moduleVar = `module_${safeJsId(mod.id)}`
      const safeMod: ZdogModuleConfig = { ...mod, id: safeJsId(mod.id) }
      const header = `const ${moduleVar} = new Zdog.Anchor({ addTo: sceneRoot, translate: { x: ${mod.x}, y: ${mod.y}, z: ${mod.z} }, scale: ${
        mod.scale ?? 1
      } });`
      let body = ''
      if (mod.type === 'barChart') body = buildBarChart(safeMod)
      else if (mod.type === 'lineChart') body = buildLineChart(safeMod)
      else if (mod.type === 'donutChart') body = buildDonutChart(safeMod)
      else if (mod.type === 'presentationBoard') body = buildPresentationBoard(safeMod)
      else if (mod.type === 'desk') body = buildDesk(safeMod)
      else if (mod.type === 'tablet') body = buildTablet(safeMod)
      return `${header}\n${body}`
    })
    .join('\n\n')
}
