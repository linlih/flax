// 原型评估：PDF 上的批注能不能在 arXiv 网页版里找回来，反过来也一样。
// 用法：node packages/core/scripts/html-anchor-eval.ts <目录>
// 目录里放同一版本的 <id>.pdf 和 <id>.html（arxiv.org/pdf/<id> 和 arxiv.org/html/<id>）。
// 随机模拟用户的选区（短语 / 一句 / 一长段），用 anchor.ts 的 quoteAt 生成原文和前后文，
// 再用 crossAnchor.ts 的 locate 去另一边找，量找到的那段和原文像不像。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { quoteAt } from '../src/anchor.ts'
import { locate, skeleton } from '../src/crossAnchor.ts'
import type { TextQuote } from '../src/model.ts'

const dir = process.argv[2]!
const PER_PAPER = Number(process.argv[3] ?? 120)
const VERBOSE = process.argv.includes('-v')

// ---------- 文字 ----------

/** 和阅读器文字层一样：每段字直接接上，行尾换行 */
async function pdfPages(file: string): Promise<string[]> {
  const task = getDocument({ data: new Uint8Array(readFileSync(file)), verbosity: 0 })
  const doc = await task.promise
  const pages: string[] = []
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const c = await page.getTextContent()
    pages.push(c.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join(''))
    page.cleanup()
  }
  await task.destroy()
  return pages
}

const BLOCK = new Set(['p', 'div', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'table', 'tr', 'td', 'th', 'figure', 'figcaption', 'blockquote', 'br', 'math', 'header', 'footer', 'dt', 'dd'])
const VOID = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'source', 'col', 'wbr'])
const SKIP = new Set(['script', 'style', 'annotation', 'annotation-xml', 'button', 'nav', 'head', 'svg'])

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[e.toLowerCase()] ?? m
  })
}

/** 网页正文的文字（相当于阅读视图里 DOM 的 textContent）。脚注挪到最后，不夹在句子中间；
 *  公式只留 MathML 里显示的符号，不要 LaTeX 源码。真做时在 WebView 里用 TreeWalker 按同样规则走 DOM */
function htmlText(html: string): string {
  const art = html.match(/<article[\s\S]*<\/article>/)?.[0] ?? html
  let body = ''
  let notes = ''
  const stack: { tag: string; skip: boolean; note: boolean }[] = []
  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:-]*)([^>]*?)(\/?)>|([^<]+)/g
  for (let m = re.exec(art); m; m = re.exec(art)) {
    const top = stack[stack.length - 1]
    if (m[4] !== undefined) {
      if (top?.skip) continue
      const text = decode(m[4])
      if (top?.note) notes += text
      else body += text
      continue
    }
    const tag = m[1]?.toLowerCase()
    if (!tag) continue
    const closing = m[0][1] === '/'
    if (BLOCK.has(tag)) {
      if (top?.note) notes += '\n'
      else body += '\n'
    }
    if (closing) {
      const at = stack.map((s) => s.tag).lastIndexOf(tag)
      if (at >= 0) stack.length = at
      continue
    }
    if (VOID.has(tag) || m[3]) continue
    const cls = m[2]!.match(/class="([^"]*)"/)?.[1] ?? ''
    stack.push({ tag, skip: !!top?.skip || SKIP.has(tag) || /\bltx_note_mark\b|\bltx_tag_note\b/.test(cls), note: !!top?.note || /\bltx_note_outer\b/.test(cls) })
  }
  return body + '\n\n' + notes
}

// ---------- 模拟选区 ----------

let seed = 1
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!

type Kind = 'phrase' | 'sentence' | 'long'
const WORDS: Record<Kind, [number, number]> = { phrase: [3, 6], sentence: [10, 25], long: [30, 60] }

/** text 里按词随机挑一段 */
function sample(text: string, kind: Kind): [number, number] | null {
  const words = [...text.matchAll(/\S+/g)].map((m) => [m.index!, m.index! + m[0].length] as const)
  const [lo, hi] = WORDS[kind]
  const n = lo + Math.floor(rand() * (hi - lo + 1))
  if (words.length < n + 2) return null
  const i = Math.floor(rand() * (words.length - n))
  return [words[i]![0], words[i + n - 1]![1]]
}

/** 正文、公式、其他（页眉、图里的字、表格、参考文献的乱字……） */
function classify(s: string): 'prose' | 'math' | 'other' {
  const toks = s.split(/\s+/).filter(Boolean)
  const wordy = toks.filter((w) => /^[(“"']?[A-Za-z][a-z]+(-[a-z]+)*[)”"',.;:!?]*$/.test(w)).length / toks.length
  const mathy = /[Ͱ-Ͽ∀-⋿←-⇿\u{1d400}-\u{1d7ff}=^_∑∫√≤≥±×·]/u.test(s) || toks.filter((w) => /^[A-Za-z]$/.test(w)).length >= 2
  if (mathy) return 'math'
  return wordy >= 0.7 ? 'prose' : 'other'
}

// ---------- 判对错 ----------

/** 骨架的编辑距离相似度，0..1 */
function similar(a: string, b: string): number {
  if (!a.length && !b.length) return 1
  const x = a.slice(0, 600)
  const y = b.slice(0, 600)
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j)
  for (let i = 1; i <= x.length; i++) {
    const cur = [i]
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1))
    prev = cur
  }
  return 1 - prev[y.length]! / Math.max(x.length, y.length)
}

type Verdict = 'same' | 'close' | 'off' | 'miss'
const perms = <T>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])))
/** 多段时按原文里的先后拼起来再比（网页里的顺序可能和 PDF 不一样） */
function verdict(found: string[] | null, exact: string): Verdict {
  if (found === null) return 'miss'
  const e = skeleton(exact).s
  const s = Math.max(...perms(found.slice(0, 4)).map((p) => similar(skeleton(p.join(' ')).s, e)))
  return s >= 0.9 ? 'same' : s >= 0.6 ? 'close' : 'off'
}

interface Row { paper: string; dir: 'pdf→html' | 'html→pdf'; kind: Kind; cls: string; how: string; v: Verdict; exact: string; found: string | null; crossPage?: boolean }

// ---------- 跑 ----------

const ids = [...new Set(readdirSync(dir).filter((f) => f.endsWith('.pdf')).map((f) => f.slice(0, -4)))].sort()
const rows: Row[] = []
const skipped: string[] = []
for (const id of ids) {
  let html: string
  try {
    html = readFileSync(join(dir, `${id}.html`), 'utf8')
  } catch {
    skipped.push(`${id}（没有网页版）`)
    continue
  }
  const hText = htmlText(html)
  const pages = await pdfPages(join(dir, `${id}.pdf`))
  if (skeleton(hText).s.length < skeleton(pages.join('\n')).s.length * 0.3) {
    skipped.push(`${id}（网页版转换失败，几乎没有正文）`)
    continue
  }
  const hSk = skeleton(hText)
  const pdfAll = pages.join('\n')
  const pSk = skeleton(pdfAll)
  const pageStart: number[] = []
  let off = 0
  for (const p of pages) {
    pageStart.push(off)
    off += p.length + 1
  }
  const pageOf = (at: number) => pageStart.findLastIndex((s) => s <= at)

  for (let k = 0; k < PER_PAPER; k++) {
    const kind = pick<Kind>(['phrase', 'sentence', 'sentence', 'long'])
    // PDF → 网页：在某一页上选（阅读器的批注本来就按页存）
    const pi = Math.floor(rand() * pages.length)
    const sp = sample(pages[pi]!, kind)
    if (sp) {
      const q = quoteAt(pages[pi]!, sp[0], sp[1])
      const r = locate(hSk, q)
      const found = r ? r.ranges.map(([s, e]) => hText.slice(s, e)) : null
      rows.push({ paper: id, dir: 'pdf→html', kind, cls: classify(q.exact), how: r ? `${r.how}${r.ranges.length > 1 ? '·多段' : ''}` : '-', v: verdict(found, q.exact), exact: q.exact, found: found?.join(' ‖ ') ?? null })
    }
    // 网页 → PDF：在网页正文里选，去整本 PDF 里找，看落在哪页
    const sh = sample(hText.slice(0, hText.lastIndexOf('\n\n')), kind)
    if (sh) {
      const q: TextQuote = quoteAt(hText, sh[0], sh[1])
      const r = locate(pSk, q)
      const found = r ? r.ranges.map(([s, e]) => pdfAll.slice(s, e)) : null
      rows.push({ paper: id, dir: 'html→pdf', kind, cls: classify(q.exact), how: r ? `${r.how}${r.ranges.length > 1 ? '·多段' : ''}` : '-', v: verdict(found, q.exact), exact: q.exact, found: found?.join(' ‖ ') ?? null, crossPage: r ? r.ranges.some(([s, e]) => pageOf(s) !== pageOf(e - 1)) : undefined })
    }
  }
  process.stderr.write(`${id} ✓\n`)
}

// ---------- 报告 ----------

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '-')
function table(title: string, groups: [string, Row[]][]) {
  console.log(`\n${title}`)
  console.log('分组'.padEnd(26) + '条数'.padStart(6) + '  对上 same  近似 close  偏了 off  没找到')
  for (const [name, rs] of groups) {
    const c = (v: Verdict) => rs.filter((r) => r.v === v).length
    console.log(name.padEnd(28) + String(rs.length).padStart(6) + pct(c('same'), rs.length).padStart(11) + pct(c('close'), rs.length).padStart(12) + pct(c('off'), rs.length).padStart(10) + pct(c('miss'), rs.length).padStart(9))
  }
}
const by = <K extends string>(rs: Row[], f: (r: Row) => K): [string, Row[]][] => {
  const m = new Map<string, Row[]>()
  for (const r of rs) m.set(f(r), [...(m.get(f(r)) ?? []), r])
  return [...m].sort((a, b) => a[0].localeCompare(b[0]))
}

console.log(`论文 ${ids.length - skipped.length} 篇，选区 ${rows.length} 条` + (skipped.length ? `；跳过：${skipped.join('、')}` : ''))
for (const d of ['pdf→html', 'html→pdf'] as const) {
  const rs = rows.filter((r) => r.dir === d)
  table(`== ${d} ==`, [['全部', rs], ...by(rs, (r) => `内容：${r.cls}`), ...by(rs, (r) => `长度：${r.kind}`), ...by(rs, (r) => `方式：${r.how}`)])
  table(`-- ${d}，只看正文（prose） 分论文 --`, by(rs.filter((r) => r.cls === 'prose'), (r) => r.paper))
}
const cross = rows.filter((r) => r.crossPage)
console.log(`\nhtml→pdf 里跨页的：${cross.length} 条（要拆成两页各自的矩形）`)

if (VERBOSE) {
  console.log('\n== 例子：正文和公式里没对上、偏了的 ==')
  for (const r of rows.filter((r) => r.v !== 'same' && r.cls !== 'other' && (!process.argv.includes('--multi') || r.how.includes('多段'))).slice(0, 40)) {
    console.log(`\n[${r.dir} ${r.cls} ${r.how} ${r.v}] ${r.paper}\n  原文：${r.exact.slice(0, 200)}\n  找到：${r.found?.replace(/\s+/g, ' ').slice(0, 200) ?? '（无）'}`)
  }
}
