// 导入流程。两段：
// 1. 立刻做：读文件、算哈希、查重、抽文字、存文件、先用 PDF 里的信息建一条记录
// 2. 排队做：联网查元数据（arXiv 有限速），查完再更新记录
// 不依赖 Electron，方便测试。
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { bibToPaper, findIdentifiers, guessFromPdf, identifyPdf, parseBibTeX, identifyText, searchByTitle, type FetchText, type FileRef, type Library, type PaperMeta, type PdfFacts } from '@flax/core'
import type { Candidate, ImportNotice } from '../shared/api'
import type { FetchBytes } from './net'
import { NotAPdfError, readPdfFacts } from './pdf'
import { sha256, type FileStore } from './store'

interface PendingDuplicate {
  existingId: string
  file: FileRef
}

export interface ImporterDeps {
  library: Library
  store: FileStore
  fetchText: FetchText
  /** 下载 PDF 用；不给就不自动下载 */
  fetchBytes?: FetchBytes
  onChanged: () => void
  onNotice: (n: ImportNotice) => void
  read?: (path: string) => Promise<Uint8Array>
  now?: () => string
}

export class Importer {
  private queue: { id: string; facts: PdfFacts }[] = []
  private running = false
  private idle: Promise<void> = Promise.resolve()
  private importing = new Set<string>()
  private downloading = new Map<string, Promise<void>>()
  private pending = new Map<string, PendingDuplicate>()
  private read: (path: string) => Promise<Uint8Array>
  private now: () => string

  constructor(private d: ImporterDeps) {
    this.read = d.read ?? (async (p) => new Uint8Array(await readFile(p)))
    this.now = d.now ?? (() => new Date().toISOString())
  }

  importingIds(): string[] {
    return [...this.importing]
  }

  downloadingIds(): string[] {
    return [...this.downloading.keys()]
  }

  /** 等排队的联网查询和下载全部做完（测试用） */
  async whenIdle(): Promise<void> {
    await this.idle
    await Promise.all(this.downloading.values())
  }

  async importPaths(paths: string[]): Promise<void> {
    for (const p of paths) {
      try {
        await this.importOne(p)
      } catch (e) {
        this.d.onNotice({ kind: 'failed', fileName: basename(p), message: e instanceof Error ? e.message : String(e) })
      }
    }
    this.d.onChanged()
    this.kick()
  }

  private async importOne(path: string): Promise<void> {
    const fileName = basename(path)
    const data = await this.read(path)
    const hash = sha256(data)
    const lib = this.d.library

    const same = lib.findDuplicate({ hash })
    if (same) {
      this.d.onNotice({ kind: 'same_file', paperId: same.paper.id, title: same.paper.title })
      return
    }
    let facts: PdfFacts
    try {
      facts = await readPdfFacts(data, fileName)
    } catch (e) {
      if (e instanceof NotAPdfError) return this.d.onNotice({ kind: 'not_pdf', fileName })
      throw e
    }
    const file = await this.storeFile(data, hash, facts, fileName)

    // 编号能直接对上库里的论文：不用等联网，马上问用户
    const ids = findIdentifiers(facts)
    const known = lib.findDuplicate(ids)
    if (known) return this.askDuplicate(known.paper.id, file)

    const guess = guessFromPdf(facts)
    const p = lib.addPaper({ ...guess, identifiers: { ...guess.identifiers, ...ids } }, { file, needsMatch: true, matchIssue: ids.arxiv || ids.doi ? 'lookup_failed' : 'no_id' })
    if (ids.arxiv || ids.doi) {
      this.importing.add(p.id)
      this.queue.push({ id: p.id, facts })
    }
  }

  /** 读入 BibTeX（Zotero、Better BibTeX、JabRef 导出的）：元数据直接用，file 字段里的 PDF 一起导进来 */
  async importBibTeX(text: string): Promise<{ added: number; existing: number; missingFiles: number }> {
    const lib = this.d.library
    let added = 0
    let existing = 0
    let missingFiles = 0
    for (const entry of parseBibTeX(text)) {
      const item = bibToPaper(entry)
      if (!item) continue
      const ids = item.meta.identifiers
      // 先读 PDF：文件哈希能对上库里的论文也算已有
      let file: FileRef | undefined
      let hash: string | undefined
      for (const path of item.files) {
        try {
          const data = await this.read(path)
          hash = sha256(data)
          const same = lib.findDuplicate({ hash })
          if (same) break
          const facts = await readPdfFacts(data, basename(path))
          file = await this.storeFile(data, hash, facts, basename(path))
          break
        } catch {
          /* 换下一个路径 */
        }
      }
      if (item.files.length && !file && !hash) missingFiles++
      const dup = lib.findDuplicate({ hash, doi: ids.doi, arxiv: ids.arxiv, title: item.meta.title })
      if (dup) {
        existing++
        if (file && !dup.paper.files.length) lib.addFile(dup.paper.id, file)
        continue
      }
      const p = lib.addPaper(item.meta, { file, needsMatch: false, batch: true })
      if (item.tags.length) lib.updatePaper(p.id, { tags: item.tags })
      added++
    }
    this.d.onChanged()
    return { added, existing, missingFiles }
  }

  /** 论文的 PDF 找不到了（资料文件夹里被删了），用户重新选了一个文件 */
  async relink(paperId: string, path: string): Promise<'ok' | 'not_pdf' | 'other_paper'> {
    const data = await this.read(path)
    const hash = sha256(data)
    const other = this.d.library.findDuplicate({ hash }, paperId)
    if (other && other.reason === 'file') return 'other_paper'
    let facts: PdfFacts
    try {
      facts = await readPdfFacts(data, basename(path))
    } catch (e) {
      if (e instanceof NotAPdfError) return 'not_pdf'
      throw e
    }
    this.d.library.replaceMainFile(paperId, await this.storeFile(data, hash, facts, basename(path)))
    this.d.onChanged()
    return 'ok'
  }

  private async storeFile(data: Uint8Array, hash: string, facts: PdfFacts, fileName: string): Promise<FileRef> {
    await this.d.store.put(data, hash)
    return { hash, size: data.byteLength, mime: 'application/pdf', pageCount: facts.pageCount, role: 'main', originalName: fileName, addedAt: this.now() }
  }

  private kick(): void {
    if (this.running || !this.queue.length) return
    this.running = true
    this.idle = (async () => {
      while (this.queue.length) {
        const job = this.queue.shift()!
        try {
          await this.lookup(job.id, job.facts)
        } finally {
          this.importing.delete(job.id)
          this.d.onChanged()
        }
      }
      this.running = false
    })()
  }

  private async lookup(id: string, facts: PdfFacts): Promise<void> {
    const lib = this.d.library
    const r = await identifyPdf(facts, this.d.fetchText)
    const paper = lib.getPaper(id)
    if (!paper) return // 查询期间被删了
    // 用户在查询期间已经手动改过，就不覆盖
    if (paper.metadataSource === 'user') return
    lib.applyMeta(id, r.meta, r.matchIssue ? { needsMatch: r.needsMatch, matchIssue: r.matchIssue } : { needsMatch: r.needsMatch })
    if (r.needsMatch) return
    const dup = lib.findDuplicate({ ...r.meta.identifiers, title: r.meta.title }, id)
    if (dup) {
      // 查完才发现是库里已有的论文：撤回刚建的记录，问用户要不要作为另一个版本
      const file = paper.files[0]
      lib.removePaper(id)
      if (file) this.askDuplicate(dup.paper.id, file)
    }
  }

  private askDuplicate(existingId: string, file: FileRef): void {
    const p = this.d.library.getPaper(existingId)!
    // 库里那条还没有 PDF（比如粘贴链接加的）：直接配上，不用问
    if (p.files.length === 0) {
      this.d.library.addFile(existingId, { ...file, role: 'main' })
      this.d.onNotice({ kind: 'attached', paperId: p.id, title: p.title })
      return
    }
    const token = `${existingId}:${file.hash}`
    this.pending.set(token, { existingId, file: { ...file, role: 'preprint' } })
    const existing: { id: string; title: string; venue?: string; year?: number; files: number } = { id: p.id, title: p.title, files: p.files.length }
    if (p.venue) existing.venue = p.venue
    if (p.year) existing.year = p.year
    this.d.onNotice({ kind: 'same_paper', token, fileName: file.originalName ?? '', existing })
  }

  resolveDuplicate(token: string, action: 'add_version' | 'skip'): void {
    const d = this.pending.get(token)
    if (!d) return
    this.pending.delete(token)
    // 选"不导入"时文件留在存储里也无妨：同一个哈希以后再导入会直接复用
    if (action === 'add_version') this.d.library.addFile(d.existingId, d.file)
    this.d.onChanged()
  }

  /** 粘贴 DOI 或 arXiv 链接：建一条没有 PDF 的记录 */
  async addFromText(text: string): Promise<boolean> {
    const ids = findIdentifiers({ fileName: '', info: {}, text })
    if (!ids.arxiv && !ids.doi) return false
    const known = this.d.library.findDuplicate(ids)
    if (known) {
      this.d.onNotice({ kind: 'same_file', paperId: known.paper.id, title: known.paper.title })
      if (known.paper.files.length === 0) this.startDownload(known.paper.id)
      return true
    }
    const label = ids.arxiv ? `arXiv:${ids.arxiv}` : ids.doi!
    const p = this.d.library.addPaper({ title: label, authors: [], identifiers: ids, source: 'user' }, { needsMatch: true, matchIssue: 'lookup_failed' })
    this.importing.add(p.id)
    this.d.onChanged()
    try {
      const r = await identifyText(text, this.d.fetchText)
      if (r && this.d.library.getPaper(p.id)) {
        this.d.library.applyMeta(p.id, r.meta, r.matchIssue ? { needsMatch: r.needsMatch, matchIssue: r.matchIssue } : { needsMatch: r.needsMatch })
      }
    } finally {
      this.importing.delete(p.id)
      this.d.onChanged()
    }
    // 元数据先到，PDF 在后台下，不让调用方等
    this.startDownload(p.id)
    return true
  }

  /** arXiv 上的论文都能免费下载 PDF。没有 arXiv 编号、已有 PDF 或正在下载时什么都不做 */
  startDownload(id: string): boolean {
    const p = this.d.library.getPaper(id)
    if (!p || !this.d.fetchBytes || !p.identifiers.arxiv || p.files.length > 0) return false
    if (this.downloading.has(id)) return true
    const job = this.download(id, p.identifiers.arxiv).finally(() => {
      this.downloading.delete(id)
      this.d.onChanged()
    })
    this.downloading.set(id, job)
    this.d.onChanged()
    return true
  }

  private async download(id: string, arxiv: string): Promise<void> {
    const fileName = `${arxiv.replace(/\//g, '_')}.pdf`
    try {
      const res = await this.d.fetchBytes!(`https://arxiv.org/pdf/${arxiv}`)
      if (res.status !== 200) throw new Error(res.status === 404 ? 'arXiv 上找不到这个编号' : `arXiv 返回 ${res.status}`)
      let facts: PdfFacts
      try {
        facts = await readPdfFacts(res.body, fileName)
      } catch (e) {
        if (e instanceof NotAPdfError) throw new Error('arXiv 返回的不是 PDF')
        throw e
      }
      const paper = this.d.library.getPaper(id)
      // 下载期间被删了，或者用户已经拖了文件进来
      if (!paper || paper.files.length > 0) return
      const hash = sha256(res.body)
      const other = this.d.library.findDuplicate({ hash })
      if (other && other.paper.id !== id) {
        this.d.onNotice({ kind: 'same_file', paperId: other.paper.id, title: other.paper.title })
        return
      }
      this.d.library.addFile(id, await this.storeFile(res.body, hash, facts, fileName))
    } catch (e) {
      const p = this.d.library.getPaper(id)
      if (p) this.d.onNotice({ kind: 'download_failed', paperId: id, title: p.title, message: e instanceof Error ? e.message : String(e) })
    }
  }

  /** 联网失败后重试，或者用户补了 DOI 以后重新查 */
  async retry(id: string): Promise<void> {
    const p = this.d.library.getPaper(id)
    if (!p) return
    const text = [p.identifiers.arxiv && `arXiv:${p.identifiers.arxiv}`, p.identifiers.doi].filter(Boolean).join(' ')
    if (!text) return
    this.importing.add(id)
    this.d.onChanged()
    try {
      const r = await identifyText(text, this.d.fetchText)
      if (r) this.d.library.applyMeta(id, r.meta, r.matchIssue ? { needsMatch: r.needsMatch, matchIssue: r.matchIssue } : { needsMatch: r.needsMatch })
    } finally {
      this.importing.delete(id)
      this.d.onChanged()
    }
    this.startDownload(id)
  }

  async candidates(id: string): Promise<Candidate[]> {
    const p = this.d.library.getPaper(id)
    if (!p) return []
    return (await searchByTitle(p.title, this.d.fetchText)).filter((c) => c.similarity >= 0.35).slice(0, 4)
  }

  applyCandidate(id: string, meta: PaperMeta): void {
    this.d.library.applyMeta(id, meta, { needsMatch: false })
    this.d.onChanged()
  }
}
