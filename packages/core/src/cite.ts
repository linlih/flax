// 引用和交换格式：复制引用（APA、GB/T 7714）、导出 BibTeX / RIS、读入 BibTeX（Zotero、Better BibTeX 导出的都行，带 PDF 路径）。
// 纯函数，不碰文件和网络。
import type { Author, Paper, PaperMeta } from './model'

export type CiteStyle = 'apa' | 'gbt7714' | 'bibtex'

type CitePaper = Pick<Paper, 'title' | 'authors' | 'year' | 'venue' | 'identifiers'> & { tags?: string[]; abstract?: string }

const CJK = /[\u3400-\u9fff]/

function fullName(a: Author): string {
  if (!a.given) return a.family
  return CJK.test(a.family + a.given) ? a.family + a.given : `${a.given} ${a.family}`
}

function initials(given: string, withDots: boolean): string {
  return given
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((g) => g[0]!.toUpperCase() + (withDots ? '.' : ''))
    .join(withDots ? ' ' : '')
}

const sentenceEnd = (s: string) => (/[.?!。？！]$/.test(s) ? s : s + '.')

/** 一条参考文献，纯文本 */
export function formatCitation(p: CitePaper, style: CiteStyle): string {
  if (style === 'bibtex') return toBibTeX([p])
  const doi = p.identifiers.doi
  const arxiv = p.identifiers.arxiv
  const link = doi ? `https://doi.org/${doi}` : arxiv ? `https://arxiv.org/abs/${arxiv}` : p.identifiers.url
  if (style === 'apa') {
    const names = p.authors.map((a) => (CJK.test(a.family) ? fullName(a) : a.given ? `${a.family}, ${initials(a.given, true)}` : a.family))
    const who =
      names.length === 0 ? '' : names.length === 1 ? names[0]! : names.length <= 20 ? `${names.slice(0, -1).join(', ')}, & ${names.at(-1)}` : `${names.slice(0, 19).join(', ')}, … ${names.at(-1)}`
    const venue = p.venue ?? (arxiv ? 'arXiv' : '')
    return [who && sentenceEnd(who), `(${p.year ?? 'n.d.'}).`, sentenceEnd(p.title), venue && sentenceEnd(venue), link].filter(Boolean).join(' ')
  }
  // GB/T 7714-2015：前三位作者，多于三位加"等"/ et al.；外文姓全大写、名缩写不加点
  const shown = p.authors.slice(0, 3).map((a) => (CJK.test(a.family) ? fullName(a) : a.given ? `${a.family.toUpperCase()} ${initials(a.given, false)}` : a.family.toUpperCase()))
  const chinese = CJK.test(p.title)
  let who = shown.join(', ')
  if (p.authors.length > 3) who += chinese ? ', 等' : ', et al'
  const kind = arxiv && !p.venue ? 'EB/OL' : 'J'
  const venue = p.venue ?? (arxiv ? `arXiv:${arxiv}` : '')
  const tail = [venue, p.year].filter(Boolean).join(', ')
  return `${who ? who + '. ' : ''}${p.title}[${kind}]. ${tail ? tail + '.' : ''}${doi ? ` DOI: ${doi}.` : kind === 'EB/OL' && link ? ` ${link}.` : ''}`.trim()
}

// —— BibTeX 导出 ——
function asciiFold(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]/g, '')
}

/** 引用键：第一作者姓 + 年份 + 标题第一个实词，重复时加 a、b… */
export function citeKeys(papers: CitePaper[]): string[] {
  const STOP = new Set(['a', 'an', 'the', 'on', 'of', 'in', 'for', 'to', 'and', 'with', 'towards', 'toward'])
  const used = new Map<string, number>()
  return papers.map((p) => {
    const fam = asciiFold(p.authors[0]?.family ?? '').toLowerCase() || 'anon'
    const word = p.title.split(/\s+/).map((w) => asciiFold(w).toLowerCase()).find((w) => w && !STOP.has(w)) ?? ''
    const base = `${fam}${p.year ?? ''}${word}`
    const n = used.get(base) ?? 0
    used.set(base, n + 1)
    return n === 0 ? base : base + String.fromCharCode(96 + n)
  })
}

const bibEscape = (s: string) => s.replace(/\\/g, '\\textbackslash{}').replace(/([&%$#_])/g, '\\$1').replace(/[{}]/g, (c) => `\\${c}`)

export function toBibTeX(papers: CitePaper[]): string {
  const keys = citeKeys(papers)
  return papers
    .map((p, i) => {
      const id = p.identifiers
      const type = p.venue ? 'article' : 'misc'
      const fields: [string, string | undefined][] = [
        ['title', `{${bibEscape(p.title)}}`],
        ['author', p.authors.length ? p.authors.map((a) => (a.given ? `${bibEscape(a.family)}, ${bibEscape(a.given)}` : `{${bibEscape(a.family)}}`)).join(' and ') : undefined],
        ['year', p.year ? String(p.year) : undefined],
        ['journal', p.venue ? bibEscape(p.venue) : undefined],
        ['doi', id.doi],
        ['eprint', id.arxiv],
        ['archivePrefix', id.arxiv ? 'arXiv' : undefined],
        ['url', id.url ?? (id.arxiv && !id.doi ? `https://arxiv.org/abs/${id.arxiv}` : undefined)],
        ['keywords', p.tags?.length ? bibEscape(p.tags.join(', ')) : undefined],
        ['abstract', p.abstract ? bibEscape(p.abstract) : undefined]
      ]
      const body = fields.filter(([, v]) => v).map(([k, v]) => `  ${k} = {${v}}`).join(',\n')
      return `@${type}{${keys[i]},\n${body}\n}`
    })
    .join('\n\n') + '\n'
}

export function toRIS(papers: CitePaper[]): string {
  return papers
    .map((p) => {
      const id = p.identifiers
      const lines: [string, string | undefined][] = [
        ['TY', p.venue ? 'JOUR' : id.arxiv ? 'PREP' : 'GEN'],
        ['TI', p.title],
        ...p.authors.map((a): [string, string] => ['AU', a.given ? `${a.family}, ${a.given}` : a.family]),
        ['PY', p.year ? String(p.year) : undefined],
        ['T2', p.venue],
        ['DO', id.doi],
        ['UR', id.url ?? (id.arxiv ? `https://arxiv.org/abs/${id.arxiv}` : undefined)],
        ['AB', p.abstract],
        ...(p.tags ?? []).map((t): [string, string] => ['KW', t]),
        ['ER', '']
      ]
      return lines.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}  - ${v}`.trimEnd()).join('\n')
    })
    .join('\n\n') + '\n'
}

// —— BibTeX 读入 ——
export interface BibEntry {
  type: string
  key: string
  fields: Record<string, string>
}

/** 解析 .bib 文本；坏的条目跳过，不抛错 */
export function parseBibTeX(text: string): BibEntry[] {
  const out: BibEntry[] = []
  const strings: Record<string, string> = {}
  let i = 0
  const n = text.length
  const ws = () => {
    while (i < n && /[\s,]/.test(text[i]!)) i++
  }
  const braced = (): string => {
    // 当前位置是 { 或 (，读到配对的结尾
    const open = text[i]!
    const close = open === '(' ? ')' : '}'
    let depth = 0
    const start = i + 1
    for (; i < n; i++) {
      const c = text[i]
      if (c === '\\') { i++; continue }
      if (c === open || (open === '(' && c === '{')) depth++
      else if (c === close || (open === '(' && c === '}')) {
        depth--
        if (depth === 0) return text.slice(start, i++)
      }
    }
    return text.slice(start)
  }
  const quoted = (): string => {
    const start = ++i
    let depth = 0
    for (; i < n; i++) {
      const c = text[i]
      if (c === '\\') { i++; continue }
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '"' && depth === 0) return text.slice(start, i++)
    }
    return text.slice(start)
  }
  const value = (): string => {
    // 值可以是 {…}、"…"、数字、@string 宏，用 # 连接
    let v = ''
    for (;;) {
      while (i < n && /\s/.test(text[i]!)) i++
      if (text[i] === '{') { v += braced() }
      else if (text[i] === '"') { v += quoted() }
      else {
        const m = /^[^\s,#}]+/.exec(text.slice(i))
        if (!m) break
        i += m[0].length
        v += /^\d+$/.test(m[0]) ? m[0] : (strings[m[0].toLowerCase()] ?? m[0])
      }
      while (i < n && /\s/.test(text[i]!)) i++
      if (text[i] === '#') { i++; continue }
      break
    }
    return v
  }
  while (i < n) {
    const at = text.indexOf('@', i)
    if (at < 0) break
    i = at + 1
    const tm = /^[A-Za-z]+/.exec(text.slice(i))
    if (!tm) continue
    const type = tm[0].toLowerCase()
    i += tm[0].length
    while (i < n && /\s/.test(text[i]!)) i++
    if (text[i] !== '{' && text[i] !== '(') continue
    if (type === 'comment' || type === 'preamble') { braced(); continue }
    const close = text[i] === '(' ? ')' : '}'
    i++
    if (type === 'string') {
      ws()
      const nm = /^[^\s=]+/.exec(text.slice(i))
      if (!nm) continue
      i += nm[0].length
      while (i < n && /[\s=]/.test(text[i]!)) i++
      strings[nm[0].toLowerCase()] = value()
      while (i < n && text[i] !== close) i++
      i++
      continue
    }
    const km = /^[^,\s}]*/.exec(text.slice(i))!
    const key = km[0]
    i += key.length
    const fields: Record<string, string> = {}
    for (;;) {
      ws()
      if (i >= n || text[i] === close) { i++; break }
      // 坏条目没有结尾：碰到下一个 @ 就放弃这条，从那里接着读
      if (text[i] === '@') break
      const fm = /^[A-Za-z][\w:.+-]*/.exec(text.slice(i))
      if (!fm) { i++; continue }
      i += fm[0].length
      while (i < n && /\s/.test(text[i]!)) i++
      if (text[i] !== '=') continue
      i++
      fields[fm[0].toLowerCase()] = value().trim()
    }
    if (Object.keys(fields).length) out.push({ type, key, fields })
  }
  return out
}

const ACCENT: Record<string, string> = { '"': '\u0308', "'": '\u0301', '`': '\u0300', '^': '\u0302', '~': '\u0303', c: '\u0327', '=': '\u0304', '.': '\u0307', u: '\u0306', v: '\u030c', H: '\u030b' }
const SPECIAL: Record<string, string> = { ss: 'ß', o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł', i: 'ı', oe: 'œ', OE: 'Œ' }

/** 把 BibTeX 里的 LaTeX 写法变成普通文字：{\"o} → ö、\& → &、-- → – */
export function latexToText(s: string): string {
  return s
    .replace(/\\([`'^"~=.])\s*\{?\\?([A-Za-z])\}?/g, (_, a: string, ch: string) => (ch + ACCENT[a]!).normalize('NFC'))
    .replace(/\\([cuvH])\s*\{([A-Za-z])\}/g, (_, a: string, ch: string) => (ch + ACCENT[a]!).normalize('NFC'))
    .replace(/\\(ss|ae|AE|oe|OE|aa|AA|o|O|l|L|i)(?![A-Za-z])\s?/g, (_, k: string) => SPECIAL[k]!)
    .replace(/\\textbackslash\{\}/g, '\\')
    .replace(/\\([&%$#_{}])/g, '$1')
    .replace(/\\(?:emph|textit|textbf|textsc|mathrm|text)\{([^{}]*)\}/g, '$1')
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/~/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseAuthors(s: string): Author[] {
  // 按顶层的 and 拆开（花括号里的不拆）
  const parts: string[] = []
  let depth = 0
  let cur = ''
  const words = s.split(/(\s+and\s+|[{}])/i)
  for (const w of words) {
    if (w === '{') depth++
    if (w === '}') depth--
    if (depth === 0 && /^\s+and\s+$/i.test(w)) {
      parts.push(cur)
      cur = ''
    } else cur += w
  }
  parts.push(cur)
  return parts
    .map((raw) => raw.trim())
    .filter((raw) => raw && raw.toLowerCase() !== 'others')
    .map((raw) => {
      if (/^\{.*\}$/.test(raw)) return { family: latexToText(raw) } // 机构名
      if (raw.includes(',')) {
        const [family, given] = raw.split(',', 2)
        return { family: latexToText(family!), given: latexToText(given!) || undefined }
      }
      const t = latexToText(raw)
      if (CJK.test(t) && !t.includes(' ')) return { family: t }
      const sp = t.lastIndexOf(' ')
      return sp < 0 ? { family: t } : { family: t.slice(sp + 1), given: t.slice(0, sp) }
    })
}

/** Zotero 的 file 字段："全文:/路径/x.pdf:application/pdf;快照:/路径/y.html:text/html"，也可能只有路径 */
export function bibFiles(file: string | undefined): string[] {
  if (!file) return []
  return file
    .split(/(?<!\\);/)
    .map((item) => {
      const segs = item.split(/(?<!\\):/)
      const path = segs.length >= 3 ? segs.slice(1, -1).join(':') : segs.length === 2 && segs[1]!.includes('/') ? segs[1]! : segs.join(':')
      return path.replace(/\\(.)/g, '$1').trim()
    })
    .filter((p) => /\.pdf$/i.test(p))
}

export interface BibImport {
  meta: PaperMeta
  tags: string[]
  files: string[]
}

export function bibToPaper(e: BibEntry): BibImport | null {
  const f = e.fields
  const title = latexToText(f['title'] ?? '')
  if (!title) return null
  const year = Number.parseInt(f['year'] ?? f['date'] ?? '', 10)
  const arxivRaw = (f['eprint'] && /arxiv/i.test(f['archiveprefix'] ?? f['eprinttype'] ?? 'arxiv') ? f['eprint'] : undefined) ?? /arxiv\.org\/abs\/([^\s}]+)/i.exec(f['url'] ?? '')?.[1]
  const doi = (f['doi'] ?? '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim() || undefined
  const venue = latexToText(f['journal'] ?? f['journaltitle'] ?? f['booktitle'] ?? f['publisher'] ?? f['school'] ?? '') || undefined
  return {
    meta: {
      title,
      authors: parseAuthors(f['author'] ?? f['editor'] ?? ''),
      year: Number.isFinite(year) && year > 1000 ? year : undefined,
      venue,
      abstract: f['abstract'] ? latexToText(f['abstract']) : undefined,
      identifiers: { doi, arxiv: arxivRaw?.replace(/v\d+$/, '') || undefined, url: f['url'] || undefined },
      source: 'user'
    },
    tags: (f['keywords'] ?? '').split(/[,;]/).map((t) => latexToText(t)).filter(Boolean),
    files: bibFiles(f['file'])
  }
}
