#!/usr/bin/env node
/**
 * Install the /dreambyte skill into a local AI editor (Claude Code, etc.).
 *
 * Copies `.claude/skills/dreambyte/` from this repo into the user's editor
 * skill directory. Defaults to `~/.claude/skills/`. Idempotent — safe to
 * re-run after pulling repo updates; existing files are overwritten in
 * place after a confirmation prompt (or `--yes`).
 *
 * Usage:
 *   node scripts/mcp/install-dreambyte-skill.mjs               # interactive install to ~/.claude/skills/
 *   node scripts/mcp/install-dreambyte-skill.mjs --yes         # no prompt
 *   node scripts/mcp/install-dreambyte-skill.mjs --target DIR  # custom target dir (e.g. ~/.codex/skills)
 *   node scripts/mcp/install-dreambyte-skill.mjs --dry-run     # show what would copy, write nothing
 *
 * The installer never touches anything outside the target directory's
 * `dreambyte/` subfolder. Other skills in the same target are left alone.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const SOURCE = path.join(REPO_ROOT, '.claude', 'skills', 'dreambyte')

function parseArgs(argv) {
  const args = { yes: false, dryRun: false, target: null, help: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--yes' || a === '-y') args.yes = true
    else if (a === '--dry-run' || a === '-n') args.dryRun = true
    else if (a === '--help' || a === '-h') args.help = true
    else if (a === '--target') args.target = argv[++i]
    else if (a.startsWith('--target=')) args.target = a.slice('--target='.length)
    else {
      console.error(`Unknown flag: ${a}`)
      process.exit(2)
    }
  }
  return args
}

function printHelp() {
  console.log(`Install the /dreambyte skill into a local AI editor.

Usage:
  node scripts/mcp/install-dreambyte-skill.mjs [flags]

Flags:
  --target DIR     Skill directory to install into.
                   Default: ~/.claude/skills
  --yes, -y        Skip the confirmation prompt.
  --dry-run, -n    Print what would be copied; write nothing.
  --help, -h       Show this help.

After install:
  - Restart your Claude Code session so it picks up the skill.
  - Type /dreambyte to verify the skill is loaded.
  - For projects-on-disk (no Dreambyte app running), register the
    Tier 2 MCP server:
      claude mcp add dreambyte-tier2 -- \\
        npx tsx scripts/mcp/mcp-tier2-server.ts /path/to/project.dreambyte`)
}

function expandHome(p) {
  if (!p) return p
  if (p === '~' || p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

async function ensureSourceLooksRight() {
  try {
    const skill = await fs.readFile(path.join(SOURCE, 'SKILL.md'), 'utf8')
    if (!skill.startsWith('---') || !/name:\s*dreambyte/.test(skill)) {
      throw new Error(`SOURCE SKILL.md does not have the expected frontmatter`)
    }
  } catch (err) {
    console.error(`Cannot find ${SOURCE}/SKILL.md — are you running this from the dreambyte repo?`)
    console.error(`  Reason: ${(err && err.message) || err}`)
    process.exit(1)
  }
}

async function listSourceFiles() {
  // Walks SOURCE recursively, returning {relPath, abs} for every file.
  const out = []
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(abs)
      else if (entry.isFile()) out.push({ abs, rel: path.relative(SOURCE, abs) })
    }
  }
  await walk(SOURCE)
  return out
}

async function confirm(question) {
  const rl = readline.createInterface({ input: stdin, output: stdout })
  try {
    const ans = await rl.question(`${question} [y/N] `)
    return /^y(es)?$/i.test(ans.trim())
  } finally {
    rl.close()
  }
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    printHelp()
    return
  }

  await ensureSourceLooksRight()

  const target = expandHome(args.target ?? path.join('~', '.claude', 'skills'))
  const destRoot = path.resolve(target)
  const destSkill = path.join(destRoot, 'dreambyte')

  const files = await listSourceFiles()

  console.log(`Source:  ${SOURCE}`)
  console.log(`Target:  ${destSkill}`)
  console.log(`Files:   ${files.length}`)
  if (args.dryRun) {
    for (const f of files) console.log(`  [dry-run] ${f.rel}`)
    console.log(`Dry run — nothing written.`)
    return
  }

  // Confirm before touching disk unless --yes.
  if (!args.yes) {
    const ok = await confirm(`Install ${files.length} files into ${destSkill}?`)
    if (!ok) {
      console.log('Aborted.')
      return
    }
  }

  await fs.mkdir(destSkill, { recursive: true })

  let copied = 0
  for (const f of files) {
    const out = path.join(destSkill, f.rel)
    await fs.mkdir(path.dirname(out), { recursive: true })
    await fs.copyFile(f.abs, out)
    copied++
  }

  console.log(`Installed ${copied} files into ${destSkill}.`)
  console.log('')
  console.log('Next steps:')
  console.log('  1. Restart your Claude Code session so it picks up the skill.')
  console.log('  2. Type /dreambyte to verify it loaded.')
  console.log('  3. For projects-on-disk (no Dreambyte app running), register the')
  console.log('     Tier 2 MCP server with the path to your project folder:')
  console.log('       claude mcp add dreambyte-tier2 -- \\')
  console.log('         npx tsx scripts/mcp/mcp-tier2-server.ts /path/to/project.dreambyte')
}

main().catch((err) => {
  console.error('install-dreambyte-skill: fatal:', (err && err.stack) || err)
  process.exit(1)
})
