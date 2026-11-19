// 识别论文和书：从 PDF 里找编号 → 查 arXiv / Crossref（书按 ISBN 查 Open Library）→ 都不行就从 PDF 文字猜。
// 网络请求由调用方注入，这里只有解析和决策逻辑，方便测试。
import type { Author, MatchIssue, PaperMeta } from './model'
import { extractArxivId, extractDoi, extractIsbn } from './ids'
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
  /** 像书的 PDF（页数多）在前后几页找到的 ISBN，13 位数字 */
  isbn?: string
}

export interface Identified {
  meta: PaperMeta
  needsMatch: boolean
  matchIssue?: MatchIssue
}

const ARXIV_API = 'https://export.arxiv.org/api/query'
const CROSSREF_API = 'https://api.crossref.org/works'
const OPENLIBRARY_API = 'https://openlibrary.org/api/books'

export interface FoundIds {
  arxiv?: string
  doi?: string
  isbn?: string
}

/** arXiv 在 PDF 左边加的戳，例如 "arXiv:1706.03762v7 [cs.CL] 2 Aug 2023"，比正文里的编号可靠 */
const ARXIV_STAMP = /arXiv:(\d{4}\.\d{4,5})(v\d+)?\s*\[[a-z-]+(?:\.[A-Za-z-]+)?\]/
/** arXiv 自己注册的 DOI，等同于 arXiv 编号 */
const ARXIV_DOI = /^10\.48550\/arxiv\.(\d{4}\.\d{4,5})$/

export function findIdentifiers(f: Pick<PdfFacts, 'fileName' | 'info' | 'text' | 'isbn'>): FoundIds {
  const stamp = ARXIV_STAMP.exec(f.text)
  const arxiv = stamp?.[1] ?? extractArxivId(f.fileName)?.id ?? extractArxivId(f.text)?.id
  let doi = extractDoi([f.info.subject, f.info.keywords].filter(Boolean).join(' ')) ?? extractDoi(f.text) ?? undefined
  const viaDoi = doi ? ARXIV_DOI.exec(doi)?.[1] : undefined
  if (viaDoi) doi = undefined
  const out: FoundIds = {}
  if (arxiv ?? viaDoi) out.arxiv = (arxiv ?? viaDoi)!
  if (doi) out.doi = doi
  // 论文集里的论文第一页也印着整本论文集的 ISBN，所以有 DOI 或 arXiv 编号时不用它
  if (f.isbn && !out.arxiv && !out.doi) out.isbn = f.isbn
  return out
}

export async function identifyPdf(f: PdfFacts, fetchText: FetchText): Promise<Identified> {
  const ids = findIdentifiers(f)
  const guess = guessFromPdf(f)
  if (!ids.arxiv && !ids.doi && !ids.isbn) return { meta: guess, needsMatch: true, matchIssue: 'no_id' }
  const r = await lookupIds(ids, fetchText)
  if (r.meta) return { meta: r.meta, needsMatch: false }
  // 编号找到了但没查到：保留编号，之后可以重试
  return { meta: { ...guess, identifiers: { ...guess.identifiers, ...ids } }, needsMatch: true, matchIssue: r.issue }
}

/** 用户粘贴的文字里的编号：DOI、arXiv 编号或链接，都没有再看是不是 ISBN */
export function idsInText(text: string): FoundIds {
  const ids = findIdentifiers({ fileName: '', info: {}, text })
  if (ids.arxiv || ids.doi) return ids
  const isbn = extractIsbn(text, true)
  return isbn ? { isbn } : {}
}

/** 用户粘贴的 DOI、arXiv 编号、链接或 ISBN */
export async function identifyText(text: string, fetchText: FetchText): Promise<Identified | null> {
  const ids = idsInText(text)
  if (!ids.arxiv && !ids.doi && !ids.isbn) return null
  const r = await lookupIds(ids, fetchText)
  if (r.meta) return { meta: r.meta, needsMatch: false }
  const label = idLabel(ids)
  return { meta: { title: label, authors: [], identifiers: ids, source: 'user' }, needsMatch: true, matchIssue: r.issue }
}

/** 还没查到信息时拿编号当标题 */
export function idLabel(ids: FoundIds): string {
  return ids.arxiv ? `arXiv:${ids.arxiv}` : ids.doi ?? `ISBN ${ids.isbn}`
}

async function lookupIds(ids: FoundIds, fetchText: FetchText): Promise<{ meta?: PaperMeta; issue: MatchIssue }> {
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
  if (ids.isbn) tries.push(async () => {
    const r = await fetchText(`${OPENLIBRARY_API}?bibkeys=ISBN:${ids.isbn}&format=json&jscmd=data`)
    return r.status === 200 ? parseOpenLibrary(JSON.parse(r.body), ids.isbn!) : null
  })
  for (const t of tries) {
    try {
      const m = await t()
      if (m) {
        m.identifiers = { ...ids, ...m.identifiers }
        if (m.source === 'arxiv' && m.venue === 'arXiv') await addPublishedVersion(m, fetchText)
        return { meta: m, issue }
      }
    } catch {
      issue = 'lookup_failed'
    }
  }
  return { issue }
}

/** arXiv 上的论文很多后来发在了会议或期刊上（CVPR、ACL、NeurIPS 2022 起……），arXiv 却不知道。
 *  到 Crossref 按标题找正式发表的版本：标题几乎一样、第一作者在作者里、年份差不多才算。
 *  找到就换成会议/期刊名、发表年份，并记下 DOI；作者和摘要仍用 arXiv 的（更全）。查不到或出错就保持原样 */
export async function addPublishedVersion(m: PaperMeta, fetchText: FetchText): Promise<void> {
  const first = m.authors[0]?.family
  if (!first || normalizeTitle(m.title).length < 8) return
  try {
    // arXiv 有时记着正式版的 DOI，却没写发在哪：直接按 DOI 查
    if (m.identifiers.doi) {
      const r = await fetchText(`${CROSSREF_API}/${encodeURIComponent(m.identifiers.doi)}`)
      const p = r.status === 200 ? parseCrossrefWork(JSON.parse(r.body).message) : null
      if (p?.venue && !/arxiv/i.test(p.venue)) {
        m.venue = p.venue
        if (p.year) m.year = p.year
      }
      return
    }
    const q = encodeURIComponent(`${m.title} ${first}`)
    const r = await fetchText(`${CROSSREF_API}?rows=5&filter=type:proceedings-article,type:journal-article,type:book-chapter&query.bibliographic=${q}`)
    if (r.status !== 200) return
    const items = (JSON.parse(r.body).message?.items ?? []) as CrossrefWork[]
    const key = (s: string) => normalizeTitle(s).replace(/ /g, '')
    for (const it of items) {
      const p = parseCrossrefWork(it)
      if (!p?.venue || !p.identifiers.doi || /arxiv/i.test(p.venue)) continue
      if (key(p.title) !== key(m.title) && titleSimilarity(p.title, m.title) < 0.95) continue
      if (!p.authors.some((a) => normalizeTitle(a.family) === normalizeTitle(first))) continue
      if (m.year && p.year && (p.year < m.year - 1 || p.year > m.year + 3)) continue
      m.venue = p.venue
      if (p.year) m.year = p.year
      m.identifiers = { ...m.identifiers, doi: p.identifiers.doi }
      return
    }
  } catch {
    // 只是锦上添花，查不到不影响导入
  }
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

const BOOK_SERIES = /^(lecture notes in|communications in computer and information science|advances in intelligent systems and computing|informatik aktuell|smart innovation|studies in computational intelligence)/i

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
  // Springer 的会议论文（ECCV、MICCAI……）先写丛书名再写论文集名，要的是论文集名
  const names = w['container-title'] ?? []
  const venue = names.find((n) => !BOOK_SERIES.test(n)) ?? names[0]
  if (venue) m.venue = clean(venue)
  if (w.abstract) m.abstract = clean(w.abstract.replace(/<[^>]+>/g, ' '))
  return m
}

interface OpenLibraryBook {
  title?: string
  subtitle?: string
  authors?: { name?: string }[]
  publishers?: { name?: string }[]
  publish_date?: string
}

/** Open Library 按 ISBN 查书的结果：{ "ISBN:978…": { … } }，没有这本书时是 {} */
export function parseOpenLibrary(body: Record<string, OpenLibraryBook> | undefined, isbn: string): PaperMeta | null {
  const b = body?.[`ISBN:${isbn}`]
  const title = clean([b?.title, b?.subtitle].filter(Boolean).join(': '))
  if (!b || !title) return null
  const m: PaperMeta = { title, authors: (b.authors ?? []).flatMap((a) => (a.name ? [splitName(clean(a.name))] : [])), identifiers: { isbn }, source: 'openlibrary' }
  const year = Number(/\b(1[5-9]|20)\d{2}\b/.exec(b.publish_date ?? '')?.[0])
  if (year) m.year = year
  const publisher = b.publishers?.[0]?.name
  if (publisher) m.venue = clean(publisher)
  return m
}

// —— 从 PDF 猜 ——

/** PDF 自带的标题常常是 "Microsoft Word - x.docx" 之类，要排除 */
function plausibleTitle(t: string | undefined): t is string {
  if (!t) return false
  const s = t.trim()
  if (!longEnough(s) || s.length > 300) return false
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
  if (f.info.author && /[a-z]|\p{Script=Han}/iu.test(f.info.author)) {
    meta.authors = f.info.author.split(/\s*(?:;|；|,|，|、| and |&)\s*/).filter((s) => s.length > 1).map(splitName)
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
  return longEnough(t) && maxSize >= 12 ? t : null
}

/** 标题至少 8 个字符；中文书名常常只有三四个字，有汉字时两个字就算 */
function longEnough(s: string): boolean {
  return s.length >= (/\p{Script=Han}/u.test(s) ? 2 : 8)
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
