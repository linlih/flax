// 全文搜索的主进程这边：索引存在本机（不在资料文件夹里，不同步、不备份），按 PDF 的哈希存。
// 正文由界面那边的 pdf.js 读出来交给这里（主进程不跑 pdf.js，大文件也不会卡住整个应用）。
import { existsSync } from 'node:fs'
import { collectHits, firstHit, normalizeQuery, plainNote, searchable, TextIndex, type Library, type NoteHit, type SqlDb, type TextSearchResult } from '@flax/core'

export interface SearchDeps {
  db: SqlDb
  library: Library
  pathFor: (hash: string) => string
  notes: { list(): { id: string; title: string }[]; read(id: string): { body: string } | null }
}

/** 每页最多存这么多字，防止异常 PDF 把索引撑大 */
const MAX_PAGE_CHARS = 50_000
const MAX_PAGES = 5_000

export function createSearch(d: SearchDeps) {
  const index = new TextIndex(d.db)

  /** 本机有文件、还没读进索引的 PDF。同步还没下载下来的不算，免得搜索去触发下载 */
  const pending = (): string[] => {
    const out = new Set<string>()
    for (const p of d.library.listPapers()) for (const f of p.files) if (!index.has(f.hash) && existsSync(d.pathFor(f.hash))) out.add(f.hash)
    return [...out]
  }

  return {
    pending,

    put(hash: string, pages: unknown): void {
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('bad hash')
      if (!Array.isArray(pages) || pages.length > MAX_PAGES || pages.some((t) => typeof t !== 'string')) throw new Error('bad pages')
      index.put(hash, (pages as string[]).map((t) => t.slice(0, MAX_PAGE_CHARS)))
    },

    /** 永久删除的论文不再占着索引（废纸篓里的还留着，恢复后不用重读） */
    prune(): void {
      const keep = new Set(d.library.liveFileHashes())
      for (const p of d.library.listTrash()) for (const f of p.files) keep.add(f.hash)
      index.prune(keep)
    },

    query(raw: string): TextSearchResult {
      const query = normalizeQuery(raw)
      if (!searchable(query)) return { query, papers: [], notes: [], pending: 0 }
      const papers = d.library.listPapers()
      const live = new Set(papers.map((p) => p.id))
      const files = papers.flatMap((p) => p.files.map((f) => ({ paperId: p.id, hash: f.hash })))
      const hits = collectHits({
        query,
        files,
        pages: index.search(query),
        annotations: d.library.searchAnnotations(query).filter((a) => live.has(a.paperId))
      })
      const notes: NoteHit[] = []
      for (const n of d.notes.list()) {
        const body = d.notes.read(n.id)?.body ?? ''
        const found = firstHit(plainNote(body), query)
        if (found) notes.push({ id: n.id, ...found.snippet })
        else if (firstHit(n.title, query)) notes.push({ id: n.id, before: '', match: '', after: '' })
      }
      return { query, papers: hits, notes, pending: pending().length }
    }
  }
}
