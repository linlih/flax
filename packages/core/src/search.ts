// 全文搜索：论文正文（按页）、批注、笔记。
// 正文的文字由阅读器那边用 pdf.js 读出来存进本机的索引（按文件哈希，换资料文件夹也能用），
// 索引只是从 PDF 算出来的，可以随时删掉重建，不同步、不备份。
import type { Annotation, HighlightColor, UUID } from './model'
import type { SqlDb } from './library'

/** 一处命中：前后各一段文字，界面上把 match 标出来 */
export interface Snippet {
  before: string
  match: string
  after: string
}

export type TextHit =
  | ({ kind: 'page'; page: number } & Snippet)
  | ({ kind: 'anno'; id: UUID; page: number; color: HighlightColor } & Snippet)

export interface PaperHits {
  paperId: UUID
  /** 按页排，同一页批注在前；界面只显示前两条 */
  hits: TextHit[]
  /** 一共几处（同一页正文里出现多次都算） */
  total: number
}

export interface NoteHit extends Snippet {
  id: string
}

export interface TextSearchResult {
  query: string
  papers: PaperHits[]
  notes: NoteHit[]
  /** 还没读进索引的 PDF 有几个（正在后台读） */
  pending: number
}

/** 中日韩文字和全角标点：它们之间的空格没有意义（PDF 里常常一个字一段，读出来带空格） */
const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\u3000-\\u303f\\uff01-\\uff60'
const CJK_GAP = new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'gu')

/** 统一写法：NFKC（有的 PDF 把"力"存成部首"⼒"、全角字母、连字 ﬁ）；空白合成一个；中文字之间不留空格 */
function tidy(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, ' ').replace(CJK_GAP, '$1').trim()
}

/** 搜索词：和正文用同样的写法 */
export function normalizeQuery(q: string): string {
  return tidy(q)
}

/** 至少两个字才搜正文（一个字母满屏都是） */
export function searchable(q: string): boolean {
  return [...normalizeQuery(q)].length >= 2
}

/** 一页的文字存之前：所有空白（包括换行）合成一个空格，跨行的词组也能搜到 */
export function flattenText(s: string): string {
  return tidy(s)
}

/** 不分大小写，找出所有出现的位置 */
export function findAll(text: string, q: string): number[] {
  const out: number[] = []
  if (!q) return out
  const hay = text.toLowerCase()
  const needle = q.toLowerCase()
  // toLowerCase 改变长度的字符（极少见）会让位置错开，这时退回逐个比较
  if (hay.length !== text.length || needle.length !== q.length) {
    for (let i = 0; i + q.length <= text.length; i++) if (text.slice(i, i + q.length).toLowerCase() === needle) out.push(i)
    return out
  }
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) out.push(i)
  return out
}

/** 命中处前后截一段：前面短、后面长，尽量从词的边界断开，断开的地方加省略号 */
export function snippetAt(text: string, at: number, len: number, before = 40, after = 100): Snippet {
  let s = Math.max(0, at - before)
  let e = Math.min(text.length, at + len + after)
  if (s > 0) {
    const sp = text.indexOf(' ', s)
    if (sp >= 0 && sp < at) s = sp + 1
  }
  if (e < text.length) {
    const sp = text.lastIndexOf(' ', e)
    if (sp > at + len) e = sp
  }
  return {
    before: (s > 0 ? '…' : '') + text.slice(s, at),
    match: text.slice(at, at + len),
    after: text.slice(at + len, e) + (e < text.length ? '…' : '')
  }
}

/** 一段文字里的第一处命中，没有就是 null；顺便数一共几处 */
export function firstHit(text: string, q: string): { snippet: Snippet; count: number } | null {
  const flat = flattenText(text)
  const all = findAll(flat, q)
  if (!all.length) return null
  return { snippet: snippetAt(flat, all[0]!, q.length), count: all.length }
}

/** 笔记的 Markdown 去掉标记再搜，摘录里不出现链接地址、井号这些 */
export function plainNote(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>+|[-*+]|\d+\.|- \[[ xX]\])\s+/gm, '')
    .replace(/(\*\*|__|`+|~~)/g, '')
}

/** 批注里搜：划的原文和自己写的评论。显示成"原文 — 评论" */
export function annotationText(a: Annotation): string {
  return [a.target.quote.exact, a.comment].filter(Boolean).join(' — ')
}

/** LIKE 的参数：q 里的 % _ \\ 当普通字符 */
export const likePattern = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`

/** 改了 tidy 的规则就加一，旧索引会重建 */
const INDEX_VERSION = 1

/** 正文索引：每个 PDF 每页一行，trigram 分词，中文英文都能按片段搜 */
export class TextIndex {
  constructor(private db: SqlDb) {
    // 文字的整理方式变了，旧索引就对不上：整个重建（索引只是从 PDF 算出来的）
    const v = (db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined)?.user_version ?? 0
    if (v !== INDEX_VERSION) db.exec(`DROP TABLE IF EXISTS pages; DROP TABLE IF EXISTS files; PRAGMA user_version = ${INDEX_VERSION};`)
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS pages USING fts5(hash UNINDEXED, page UNINDEXED, text, tokenize = 'trigram');
      CREATE TABLE IF NOT EXISTS files (hash TEXT PRIMARY KEY, pages INTEGER NOT NULL, at TEXT NOT NULL);
    `)
  }

  has(hash: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM files WHERE hash = ?').get(hash))
  }

  /** 存一个 PDF 的各页文字（第 1 页在 pages[0]）。读不出文字的（扫描版）也记一笔，免得反复读 */
  put(hash: string, pages: string[], at = new Date().toISOString()): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM pages WHERE hash = ?').run(hash)
      const ins = this.db.prepare('INSERT INTO pages (hash, page, text) VALUES (?, ?, ?)')
      pages.forEach((t, i) => {
        const flat = flattenText(t)
        if (flat) ins.run(hash, i + 1, flat)
      })
      this.db.prepare('INSERT INTO files (hash, pages, at) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET pages = excluded.pages, at = excluded.at').run(hash, pages.length, at)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /** 不在 keep 里的（论文永久删除了）从索引里去掉 */
  prune(keep: Set<string>): void {
    const rows = this.db.prepare('SELECT hash FROM files').all() as { hash: string }[]
    for (const { hash } of rows) {
      if (keep.has(hash)) continue
      this.db.prepare('DELETE FROM pages WHERE hash = ?').run(hash)
      this.db.prepare('DELETE FROM files WHERE hash = ?').run(hash)
    }
  }

  /** 包含 q 的页（不分大小写）。三个字以上走索引，更短的逐页找，几百篇论文也很快 */
  search(q: string, limit = 2000): { hash: string; page: number; text: string }[] {
    return this.db.prepare('SELECT hash, page, text FROM pages WHERE text LIKE ? ESCAPE \'\\\' LIMIT ?').all(likePattern(q), limit) as { hash: string; page: number; text: string }[]
  }
}

/** 把正文、批注、笔记的命中按论文合起来 */
export function collectHits(opts: {
  query: string
  /** 每篇论文用到的 PDF */
  files: { paperId: UUID; hash: string }[]
  pages: { hash: string; page: number; text: string }[]
  annotations: Annotation[]
}): PaperHits[] {
  const q = opts.query
  const byHash = new Map<string, UUID[]>()
  for (const f of opts.files) byHash.set(f.hash, [...(byHash.get(f.hash) ?? []), f.paperId])
  const out = new Map<UUID, PaperHits>()
  const add = (paperId: UUID, hit: TextHit, count: number) => {
    const p = out.get(paperId) ?? { paperId, hits: [], total: 0 }
    p.hits.push(hit)
    p.total += count
    out.set(paperId, p)
  }
  for (const row of opts.pages) {
    const found = firstHit(row.text, q)
    if (!found) continue
    for (const id of byHash.get(row.hash) ?? []) add(id, { kind: 'page', page: Number(row.page), ...found.snippet }, found.count)
  }
  for (const a of opts.annotations) {
    const found = firstHit(annotationText(a), q)
    if (found) add(a.paperId, { kind: 'anno', id: a.id, page: a.page + 1, color: a.color, ...found.snippet }, 1)
  }
  for (const p of out.values()) p.hits.sort((x, y) => x.page - y.page || (x.kind === 'anno' ? -1 : 0) - (y.kind === 'anno' ? -1 : 0))
  return [...out.values()]
}

