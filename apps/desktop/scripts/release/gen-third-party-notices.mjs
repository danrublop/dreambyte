#!/usr/bin/env node
// Regenerates the npm-dependency section of THIRD_PARTY_NOTICES.md from
// package-lock.json (non-dev entries) + license files in node_modules.
// Run after `npm ci`: node scripts/release/gen-third-party-notices.mjs
// Everything above the BEGIN marker is hand-written and preserved.
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..')
const target = path.join(root, 'docs', 'THIRD_PARTY_NOTICES.md')
const BEGIN = '<!-- BEGIN GENERATED: npm-dependencies (apps/desktop/scripts/release/gen-third-party-notices.mjs) -->'
const END = '<!-- END GENERATED: npm-dependencies -->'

const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages
const isCopyright = (l) => /copyright|\(c\)|©/i.test(l) && l.length < 200

const byName = new Map()
for (const [key, meta] of Object.entries(lock)) {
  if (!key.startsWith('node_modules/') || meta.dev || meta.link) continue
  const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)
  const dir = path.join(root, key)
  let pkg = {}
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {}
  const license = String(meta.license ?? pkg.license ?? 'UNKNOWN')
  let text = ''
  try {
    const f = fs.readdirSync(dir).find((n) => /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i.test(n))
    if (f) text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim()
  } catch {}
  const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name
  const copyrights = [...new Set(text.split('\n').map((l) => l.trim()).filter(isCopyright))]
  if (!copyrights.length && author) copyrights.push(`Copyright (c) ${author.replace(/\s*<[^>]*>/, '')}`)
  const id = `${name}@${meta.version}`
  if (byName.has(id)) continue
  const body = text
    .split('\n')
    .filter((l) => !isCopyright(l.trim()))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
  byName.set(id, { name, version: meta.version, license, copyrights, text, body, optional: !!meta.optional, installed: !!text || fs.existsSync(dir) })
}

const entries = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
const groups = new Map()
for (const e of entries) {
  if (!e.body) continue
  if (!groups.has(e.body)) groups.set(e.body, { text: e.text, members: [] })
  groups.get(e.body).members.push(e)
}
const groupIndex = new Map()
;[...groups.values()].forEach((g, i) => g.members.forEach((m) => groupIndex.set(m, i + 1)))

const counts = {}
for (const e of entries) counts[e.license] = (counts[e.license] ?? 0) + 1
const esc = (s) => s.replace(/\|/g, '\\|').replace(/</g, '&lt;')

const out = [BEGIN, '', '## npm dependencies', '']
out.push(
  `Generated from \`package-lock.json\` (${entries.length} non-dev packages, including optional platform binaries). ` +
    'Regenerate with `node apps/desktop/scripts/release/gen-third-party-notices.mjs` after `npm ci`. Development-only tooling is not listed ' +
    'because it is not distributed with the app.',
  '',
  '**Licenses:** ' +
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([l, n]) => `${l} (${n})`)
      .join(', '),
  '',
  '| Package | Version | License | Copyright | Text |',
  '| --- | --- | --- | --- | --- |'
)
for (const e of entries) {
  const g = groupIndex.get(e)
  const note = g
    ? `[L${g}](#license-text-l${g})`
    : e.installed
      ? `no license file in package; standard ${esc(e.license)} terms`
      : 'platform binary not installed where generated'
  out.push(`| ${esc(e.name)} | ${e.version} | ${esc(e.license)} | ${esc(e.copyrights.slice(0, 3).join('; '))} | ${note} |`)
}
out.push('', '## License texts', '')
;[...groups.values()].forEach((g, i) => {
  out.push(`### License text L${i + 1}`, '', `Used by: ${g.members.map((m) => `${m.name}@${m.version}`).join(', ')}`, '', '```text', g.text.replace(/```/g, "'''"), '```', '')
})
out.push(END, '')

const current = fs.readFileSync(target, 'utf8')
const head = current.includes(BEGIN) ? current.slice(0, current.indexOf(BEGIN)) : current.trimEnd() + '\n\n'
fs.writeFileSync(target, head + out.join('\n'))
console.log(`${entries.length} packages, ${groups.size} distinct license texts`)
