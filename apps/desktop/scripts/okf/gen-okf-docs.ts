/**
 * gen-okf-docs — a browsable reader for the whole OKF knowledge bundle.
 *
 * Renders docs/okf-docs.html: a LEFT file-tree of every knowledge .md (craft
 * rules, renderer rules, skills, bundle docs) grouped + searchable;
 * click one to read its rendered markdown. The markdown is rendered to HTML HERE
 * (build time) — robust, testable — and embedded, so the client JS is trivial.
 * Self-contained, no CDN.
 *
 * Run: npx tsx scripts/okf/gen-okf-docs.ts
 */
import fs from 'fs'
import path from 'path'
import { parseFrontmatter } from '../../src/lib/agents/okf/frontmatter'

const CWD = process.cwd()
const ROUTING = new Set(['core', 'lane:motion', 'lane:media', 'lane:avatar', 'format:shortform'])
const RESERVED = new Set(['README.md'])

// ── Markdown → HTML (build-time, careful) ───────────────────────────────────
function escHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string)
}
function inline(s: string): string {
  s = escHtml(s)
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
  return s
}
/** A markdown table separator row: only |, -, :, spaces, and at least one dash. */
function isTableSep(l: string): boolean {
  return /^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-{0,}:?\s*$/.test(l) || /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(l)
}
function cells(l: string): string[] {
  return l
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim())
}
function mdToHtml(src: string): string {
  const L = src.replace(/\r\n?/g, '\n').split('\n')
  const o: string[] = []
  let i = 0
  while (i < L.length) {
    const line = L[i]
    // fenced code
    if (/^```/.test(line)) {
      const c: string[] = []
      i++
      while (i < L.length && !/^```/.test(L[i])) {
        c.push(escHtml(L[i]))
        i++
      }
      i++
      o.push('<pre><code>' + c.join('\n') + '</code></pre>')
      continue
    }
    // table — only if the header has a pipe AND the next line is a real separator
    if (/\|/.test(line) && i + 1 < L.length && isTableSep(L[i + 1])) {
      const head = line
      const rows: string[] = []
      i += 2
      while (i < L.length && /\|/.test(L[i]) && L[i].trim() !== '') {
        rows.push(L[i])
        i++
      }
      const th = cells(head).map((c) => '<th>' + inline(c) + '</th>').join('')
      const tr = rows.map((r) => '<tr>' + cells(r).map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('')
      o.push('<table><thead><tr>' + th + '</tr></thead><tbody>' + tr + '</tbody></table>')
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const n = h[1].length
      o.push(`<h${n}>` + inline(h[2]) + `</h${n}>`)
      i++
      continue
    }
    if (/^---+\s*$/.test(line)) {
      o.push('<hr>')
      i++
      continue
    }
    if (/^>\s?/.test(line)) {
      const bq: string[] = []
      while (i < L.length && /^>\s?/.test(L[i])) {
        bq.push(L[i].replace(/^>\s?/, ''))
        i++
      }
      o.push('<blockquote>' + inline(bq.join(' ')) + '</blockquote>')
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const it: string[] = []
      while (i < L.length && /^\s*[-*]\s+/.test(L[i])) {
        it.push('<li>' + inline(L[i].replace(/^\s*[-*]\s+/, '')) + '</li>')
        i++
      }
      o.push('<ul>' + it.join('') + '</ul>')
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const ol: string[] = []
      while (i < L.length && /^\s*\d+\.\s+/.test(L[i])) {
        ol.push('<li>' + inline(L[i].replace(/^\s*\d+\.\s+/, '')) + '</li>')
        i++
      }
      o.push('<ol>' + ol.join('') + '</ol>')
      continue
    }
    if (/^\s*$/.test(line)) {
      i++
      continue
    }
    const p: string[] = [line]
    i++
    while (i < L.length && !/^\s*$/.test(L[i]) && !/^(#{1,6}\s|>\s|\s*[-*]\s|\s*\d+\.\s|```)/.test(L[i]) && !(/\|/.test(L[i]) && i + 1 < L.length && isTableSep(L[i + 1]))) {
      p.push(L[i])
      i++
    }
    o.push('<p>' + inline(p.join(' ')) + '</p>')
  }
  return o.join('\n')
}

// ── Collect docs ────────────────────────────────────────────────────────────
interface Doc {
  section: string
  id: string
  title: string
  type: string
  tags: string[]
  html: string
}

function readDoc(file: string): { meta: Record<string, unknown>; body: string } | null {
  try {
    return parseFrontmatter(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
function collectDir(dir: string, classify: (id: string, tags: string[]) => string): Doc[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir).sort()
  } catch {
    return []
  }
  const out: Doc[] = []
  for (const name of names) {
    if (!name.endsWith('.md') || RESERVED.has(name)) continue
    const parsed = readDoc(path.join(dir, name))
    if (!parsed) continue
    const id = name.slice(0, -3)
    const tags = Array.isArray(parsed.meta.tags) ? parsed.meta.tags.filter((t): t is string => typeof t === 'string') : []
    const type = typeof parsed.meta.type === 'string' ? parsed.meta.type : 'unknown'
    const title = typeof parsed.meta.title === 'string' ? parsed.meta.title : id
    out.push({ section: classify(id, tags), id, title, type, tags, html: mdToHtml(parsed.body) })
  }
  return out
}

const DB = path.join(CWD, '.claude', 'skills', 'dreambyte')
const docs: Doc[] = []
docs.push(
  ...collectDir(path.join(DB, 'rules'), (id, tags) =>
    id === 'index' || id === 'log' ? 'Bundle docs' : tags.some((t) => ROUTING.has(t)) ? 'Craft rules' : 'Renderer rules',
  ),
)
docs.push(...collectDir(path.join(CWD, 'src', 'lib', 'skills', 'library'), () => 'Skill library'))
for (const f of ['SKILL.md', 'index.md', 'log.md']) {
  const parsed = readDoc(path.join(DB, f))
  if (!parsed) continue
  const id = f.slice(0, -3)
  docs.push({
    section: 'Bundle docs',
    id,
    title: typeof parsed.meta.title === 'string' ? parsed.meta.title : id,
    type: typeof parsed.meta.type === 'string' ? parsed.meta.type : id,
    tags: Array.isArray(parsed.meta.tags) ? (parsed.meta.tags as string[]) : [],
    html: mdToHtml(parsed.body),
  })
}

const SECTION_ORDER = ['Craft rules', 'Renderer rules', 'Skill library', 'Bundle docs']

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>OKF Knowledge — Docs</title>
<style>
  :root{--bg:#0f1115;--panel:#13161c;--card:#171a21;--line:#2a2f3a;--ink:#e6e6e6;--mut:#8b95a7;--acc:#4ea1ff;}
  *{box-sizing:border-box} html,body{height:100%} body{margin:0;font:14px/1.6 system-ui,sans-serif;background:var(--bg);color:var(--ink);display:flex}
  #nav{width:300px;min-width:300px;height:100vh;overflow:auto;background:var(--panel);border-right:1px solid var(--line);padding:14px}
  #nav h1{font-size:14px;margin:2px 0 10px} #q{width:100%;background:var(--card);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:7px 10px;margin-bottom:12px;font-size:13px}
  .sec{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--mut);margin:14px 0 6px}
  .f{padding:6px 9px;border-radius:7px;color:var(--ink);cursor:pointer;font-size:13px}
  .f:hover{background:var(--card)} .f.on{background:var(--card);box-shadow:0 0 0 1px var(--acc) inset;color:#fff}
  .f .meta{color:var(--mut);font-size:11px}
  #main{flex:1;height:100vh;overflow:auto;padding:28px 40px;min-width:0}
  .doc{max-width:820px}
  #chips{margin:0 0 18px} .chip{display:inline-block;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:2px 10px;font-size:11px;color:var(--mut);margin:0 6px 6px 0}
  .chip.type{color:#0f1115;background:var(--acc);border:none;font-weight:600}
  #doc{overflow-wrap:anywhere}
  #doc h1{font-size:25px;margin:.2em 0 .5em} #doc h2{font-size:19px;margin:1.4em 0 .4em;border-bottom:1px solid var(--line);padding-bottom:4px}
  #doc h3{font-size:16px;margin:1.2em 0 .3em;color:#cdd3df} #doc h4{font-size:14px;color:var(--mut);margin:1em 0 .2em}
  #doc p{margin:.6em 0} #doc ul,#doc ol{margin:.5em 0;padding-left:1.4em} #doc li{margin:.2em 0}
  #doc code{background:#0c0e13;border:1px solid var(--line);border-radius:4px;padding:1px 5px;font-size:12.5px}
  #doc pre{background:#0c0e13;border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow:auto;white-space:pre} #doc pre code{border:none;padding:0;background:none}
  #doc table{border-collapse:collapse;margin:.8em 0;font-size:13px} #doc th,#doc td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}
  #doc th{background:var(--card)} #doc blockquote{border-left:3px solid var(--acc);margin:.8em 0;padding:.2em 14px;color:var(--mut);background:#12141a;border-radius:0 8px 8px 0}
  #doc hr{border:none;border-top:1px solid var(--line);margin:1.4em 0} #doc a{color:var(--acc)} #doc strong{color:#fff}
</style></head><body>
<div id="nav"><h1>OKF Knowledge Bundle</h1><input id="q" placeholder="filter files…"><div id="tree"></div></div>
<div id="main"><div class="doc"><div id="chips"></div><div id="doc"></div></div></div>
<script>
const DOCS = ${JSON.stringify(docs)};
const ORDER = ${JSON.stringify(SECTION_ORDER)};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];});}
const tree=document.getElementById('tree'), q=document.getElementById('q'), docEl=document.getElementById('doc'), chipsEl=document.getElementById('chips'), main=document.getElementById('main');
let current=null;
function key(d){return d.section+'::'+d.id;}
function show(d){
  current=key(d);
  Array.prototype.forEach.call(document.querySelectorAll('.f'),function(e){e.classList.toggle('on',e.dataset.k===current);});
  chipsEl.innerHTML='<span class="chip type">'+esc(d.type)+'</span>'+d.tags.map(function(t){return '<span class="chip">'+esc(t)+'</span>';}).join('');
  docEl.innerHTML=d.html;
  main.scrollTop=0;
}
function build(filter){
  tree.innerHTML='';
  ORDER.forEach(function(sec){
    const items=DOCS.filter(function(d){return d.section===sec&&(!filter||(d.title+' '+d.id).toLowerCase().indexOf(filter)>=0);});
    if(!items.length)return;
    const head=document.createElement('div');head.className='sec';head.textContent=sec;tree.appendChild(head);
    items.forEach(function(d){
      const a=document.createElement('div');a.className='f';a.dataset.k=key(d);
      a.innerHTML='<div>'+esc(d.title)+'</div><div class="meta">'+esc(d.id)+'.md</div>';
      if(key(d)===current)a.classList.add('on');
      a.addEventListener('click',function(){show(d);});
      tree.appendChild(a);
    });
  });
}
q.addEventListener('input',function(){build(q.value.trim().toLowerCase());});
build('');
show(DOCS.find(function(d){return d.section==='Craft rules';})||DOCS[0]);
</script></body></html>
`

const out = path.join(CWD, 'docs', 'okf-docs.html')
fs.writeFileSync(out, page)
console.log(`[gen-okf-docs] ${docs.length} docs → ${path.relative(CWD, out)}`)
