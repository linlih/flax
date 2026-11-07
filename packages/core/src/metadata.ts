// 识别论文：从 PDF 里找编号 → 查 arXiv / Crossref → 都不行就从 PDF 文字猜。
// 网络请求由调用方注入，这里只有解析和决策逻辑，方便测试。
import type { Author, MatchIssue, PaperMeta } from './model'
import { extractArxivId, extractDoi } from './ids'
import { normalizeTitle, titleSimilarity } from './text'

export type FetchText = (url: string) => Promise<{ status: number; body: string }>

export interface TextLine {
  text: string
  /** 字号，单位 pt */
  size: number
  /** 页面坐标，越大越靠上 */
  y: number
}

/** 从 PDF 读出来的原始信息 */
export interface PdfFacts {
  fileName: string
  info: { title?: string; author?: string; subject?: string; keywords?: string }
  /** 前两页的全部文字 */
  text: string
  /** 第一页的文字行，带字号 */
  lines: TextLine[]
  pageCount: number
}

export interface Identified {
  meta: PaperMeta
  needsMatch: boolean
  matchIssue?: MatchIssue
}

const ARXIV_API = 'https://export.arxiv.org/api/query'
const CROSSREF_API = 'https://api.crossref.org/works'

/** arXiv 在 PDF 左边加的戳，例如 "arXiv:1706.03762v7 [cs.CL] 2 Aug 2023"，比正文里的编号可靠 */
const ARXIV_STAMP = /arXiv:(\d{4}\.\d{4,5})(v\d+)?\s*\[[a-z-]+(?:\.[A-Za-z-]+)?\]/
/** arXiv 自己注册的 DOI，等同于 arXiv 编号 */
const ARXIV_DOI = /^10\.48550\/arxiv\.(\d{4}\.\d{4,5})$/

export function findIdentifiers(f: Pick<PdfFacts, 'fileName' | 'info' | 'text'>): { arxiv?: string; doi?: string } {
  const stamp = ARXIV_STAMP.exec(f.text)
  const arxiv = stamp?.[1] ?? extractArxivId(f.fileName)?.id ?? extractArxivId(f.text)?.id
  let doi = extractDoi([f.info.subject, f.info.keywords].filter(Boolean).join(' ')) ?? extractDoi(f.text) ?? undefined
  const viaDoi = doi ? ARXIV_DOI.exec(doi)?.[1] : undefined
  if (viaDoi) doi = undefined
  const out: { arxiv?: string; doi?: string } = {}
  if (arxiv ?? viaDoi) out.arxiv = (arxiv ?? viaDoi)!
  if (doi) out.doi = doi
  return out
}

export async function identifyPdf(f: PdfFacts, fetchText: FetchText): Promise<Identified> {
  const ids = findIdentifiers(f)
  const guess = guessFromPdf(f)
  if (!ids.arxiv && !ids.doi) return { meta: guess, needsMatch: true, matchIssue: 'no_id' }
  const r = await lookupIds(ids, fetchText)
  if (r.meta) return { meta: r.meta, needsMatch: false }
  // 编号找到了但没查到：保留编号，之后可以重试
  return { meta: { ...guess, identifiers: { ...guess.identifiers, ...ids } }, needsMatch: true, matchIssue: r.issue }
}

/** 用户粘贴的 DOI、arXiv 编号或链接 */
export async function identifyText(text: string, fetchText: FetchText): Promise<Identified | null> {
  const ids = findIdentifiers({ fileName: '', info: {}, text })
  if (!ids.arxiv && !ids.doi) return null
  const r = await lookupIds(ids, fetchText)
  if (r.meta) return { meta: r.meta, needsMatch: false }
  const label = ids.arxiv ? `arXiv:${ids.arxiv}` : ids.doi!
  return { meta: { title: label, authors: [], identifiers: ids, source: 'user' }, needsMatch: true, matchIssue: r.issue }
}

async function lookupIds(ids: { arxiv?: string; doi?: string }, fetchText: FetchText): Promise<{ meta?: PaperMeta; issue: MatchIssue }> {
  let issue: MatchIssue = 'not_found'
  const tries: (() => Promise<PaperMeta | null>)[] = []
  if (ids.doi) tries.push(async () => {
    const r = await fetchText(`${CROSSREF_API}/${encodeURIComponent(ids.doi!)}`)
    return r.status === 200 ? parseCrossrefWork(JSON.parse(r.body).message) : null
  })
  if (ids.arxiv) tries.push(async () => {
    const r = await fetchText(`${ARXIV_API}?id_list=${encodeURIComponent(ids.arxiv!)}`)
    return r.status === 200 ? parseArxivFeed(r.body)[0] ?? null : null
  })
  // 有 arXiv 编号时先查 arXiv：它的数据最完整，DOI 可能来自正文里引用的别的论文
  if (ids.arxiv) tries.reverse()
  for (const t of tries) {
    try {
      const m = await t()
      if (m) {
        m.identifiers = { ...ids, ...m.identifiers }
        return { meta: m, issue }
      }
    } catch {
      issue = 'lookup_failed'
    }
  }
  return { issue }
}

/** 按标题搜候选，用在"需要匹配"时。结果按标题相似度排序 */
export async function searchByTitle(title: string, fetchText: FetchText): Promise<(PaperMeta & { similarity: number })[]> {
  const q = title.trim()
  if (normalizeTitle(q).length < 8) return []
  const out: PaperMeta[] = []
  const jobs = [
    fetchText(`${CROSSREF_API}?rows=3&query.bibliographic=${encodeURIComponent(q)}`).then((r) => {
      if (r.status !== 200) return
      for (const it of JSON.parse(r.body).message?.items ?? []) {
        const m = parseCrossrefWork(it)
        if (m) out.push(m)
      }
    }),
    fetchText(`${ARXIV_API}?max_results=3&search_query=${encodeURIComponent(`ti:"${q.replace(/"/g, '')}"`)}`).then((r) => {
      if (r.status === 200) out.push(...parseArxivFeed(r.body))
    })
  ]
  const settled = await Promise.allSettled(jobs)
  if (settled.every((s) => s.status === 'rejected')) throw new Error('lookup_failed')
  return out
    .map((m) => ({ ...m, similarity: titleSimilarity(q, m.title) }))
    .sort((a, b) => b.similarity - a.similarity)
}

// —— 解析 ——

export function parseArxivFeed(xml: string): PaperMeta[] {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? []
  const out: PaperMeta[] = []
  for (const e of entries) {
    const idUrl = tag(e, 'id') ?? ''
    const id = /abs\/(.+?)(v\d+)?$/.exec(idUrl)?.[1]
    const title = clean(tag(e, 'title') ?? '')
    // 编号不存在时 arXiv 会返回一条标题是 Error 的记录
    if (!id || !title || title === 'Error') continue
    const authors = [...e.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => splitName(clean(m[1] ?? '')))
    const published = tag(e, 'published')
    const journal = tag(e, 'arxiv:journal_ref')
    const doi = tag(e, 'arxiv:doi')
    const m: PaperMeta = {
      title,
      authors,
      identifiers: { arxiv: id, ...(doi ? { doi: clean(doi).toLowerCase() } : {}) },
      venue: journal ? clean(journal) : 'arXiv',
      source: 'arxiv'
    }
    const year = published ? Number(published.slice(0, 4)) : NaN
    if (year) m.year = year
    const summary = tag(e, 'summary')
    if (summary) m.abstract = clean(summary)
    out.push(m)
  }
  return out
}

interface CrossrefWork {
  DOI?: string
  title?: string[]
  author?: { given?: string; family?: string; name?: string }[]
  issued?: { 'date-parts'?: (number | null)[][] }
  published?: { 'date-parts'?: (number | null)[][] }
  'container-title'?: string[]
  abstract?: string
}

export function parseCrossrefWork(w: CrossrefWork | undefined): PaperMeta | null {
  const title = clean(w?.title?.[0] ?? '')
  if (!w || !title) return null
  const authors: Author[] = (w.author ?? []).flatMap((a) => {
    if (a.family) return [a.given ? { given: clean(a.given), family: clean(a.family) } : { family: clean(a.family) }]
    return a.name ? [{ family: clean(a.name) }] : []
  })
  const m: PaperMeta = { title, authors, identifiers: {}, source: 'crossref' }
  if (w.DOI) m.identifiers.doi = w.DOI.toLowerCase()
  const year = (w.issued ?? w.published)?.['date-parts']?.[0]?.[0]
  if (year) m.year = year
  const venue = w['container-title']?.[0]
  if (venue) m.venue = clean(venue)
  if (w.abstract) m.abstract = clean(w.abstract.replace(/<[^>]+>/g, ' '))
  return m
}

// —— 从 PDF 猜 ——

/** PDF 自带的标题常常是 "Microsoft Word - x.docx" 之类，要排除 */
function plausibleTitle(t: string | undefined): t is string {
  if (!t) return false
  const s = t.trim()
  if (s.length < 8 || s.length > 300) return false
  if (/^(untitled|microsoft word|title|paper|document|main|arxiv)\b/i.test(s)) return false
  if (/\.(pdf|docx?|tex|dvi)$/i.test(s)) return false
  if (/^[\w-]+$/.test(s)) return false // 没有空格，像文件名
  return true
}

export function guessFromPdf(f: PdfFacts): PaperMeta {
  const meta: PaperMeta = { title: '', authors: [], identifiers: {}, source: 'pdf' }
  if (plausibleTitle(f.info.title)) meta.title = clean(f.info.title)
  else {
    const fromLines = titleFromLines(f.lines)
    if (fromLines) meta.title = fromLines
  }
  if (!meta.title) {
    meta.title = f.fileName.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim() || '未命名论文'
    meta.source = 'filename'
  }
  if (f.info.author && /[a-z]/i.test(f.info.author)) {
    meta.authors = f.info.author.split(/\s*(?:;|,| and |&)\s*/).filter((s) => s.length > 1).map(splitName)
  }
  return meta
}

/** 第一页上半部分字号最大的几行，通常就是标题 */
function titleFromLines(lines: TextLine[]): string | null {
  const usable = lines.filter((l) => l.text.trim().length > 1 && !/^arXiv:/i.test(l.text.trim()))
  if (!usable.length) return null
  const top = Math.max(...usable.map((l) => l.y))
  const upper = usable.filter((l) => l.y > top - 400)
  const maxSize = Math.max(...upper.map((l) => l.size))
  const big = upper.filter((l) => l.size >= maxSize - 0.5).sort((a, b) => b.y - a.y)
  // 只取连续的几行（行距不超过两倍字号）
  const picked = [big[0]!]
  for (const l of big.slice(1)) {
    if (picked.at(-1)!.y - l.y <= maxSize * 2.2 && picked.length < 4) picked.push(l)
    else break
  }
  const t = clean(picked.map((l) => l.text).join(' '))
  return t.length >= 8 && maxSize >= 12 ? t : null
}

// —— 小工具 ——

function tag(xml: string, name: string): string | undefined {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`)
  return re.exec(xml)?.[1]
}

function clean(s: string): string {
  return decodeEntities(s).replace(/\s+/g, ' ').trim()
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const k = e.toLowerCase()
    if (k === 'amp') return '&'
    if (k === 'lt') return '<'
    if (k === 'gt') return '>'
    if (k === 'quot') return '"'
    if (k === 'apos') return "'"
    return String.fromCodePoint(k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10))
  })
}

/** "Ashish Vaswani" → { given: 'Ashish', family: 'Vaswani' }；"Vaswani, Ashish" 也能处理 */
export function splitName(name: string): Author {
  const n = name.trim()
  if (n.includes(',')) {
    const [family, given] = n.split(',').map((s) => s.trim())
    return given ? { given, family: family! } : { family: family! }
  }
  const parts = n.split(/\s+/)
  if (parts.length === 1) return { family: parts[0]! }
  return { given: parts.slice(0, -1).join(' '), family: parts.at(-1)! }
}
