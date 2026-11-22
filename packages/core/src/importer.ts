// 导入流程。两段：
// 1. 立刻做：读文件、算哈希、查重、抽文字、存文件、先用 PDF 里的信息建一条记录
// 2. 排队做：联网查元数据（arXiv 有限速），查完再更新记录
// 不依赖平台：读文件、算哈希、存文件、读 PDF 里的文字都由平台传进来（桌面用 node:fs、node:crypto 和 pdf.js）。
import { findIdentifiers, guessFromPdf, identifyPdf, identifyText, idLabel, idsInText, searchByTitle, splitName, type FetchText, type FoundIds, type PdfFacts } from './metadata'
import { bibToPaper, parseBibTeX } from './cite'
import type { Library } from './library'
import type { FileRef, Paper, PaperMeta } from './model'
import { BOOK_PAGES } from './pdfFacts'

export interface Candidate extends PaperMeta {
  similarity: number
}

/** 浏览器插件从网页上读到的论文信息（字段都来自网页，不可信，用前要检查） */
export interface PageInfo {
  url: string
  /** 网页上找到的编号（citation_doi、citation_arxiv_id、网址） */
  ids?: { doi?: string; arxiv?: string }
  /** 网页上的 citation_* 信息：联网查不到时用它，不只剩一个编号当标题 */
  meta?: { title?: string; authors?: string[]; year?: number; venue?: string; abstract?: string }
  /** 标签页里直接打开的是 PDF：Flax 按网址自己下载这个文件 */
  isPdf?: boolean
}

/** 插件存完或查完以后，告诉它库里那一篇的情况 */
export interface PageResult {
  paperId: string
  title: string
  /** 有 PDF，或者正在下 */
  hasPdf: boolean
  /** yes：库里有 PDF；downloading：Flax 正在下（arXiv、开放获取）；no：还没有 */
  pdf: 'yes' | 'downloading' | 'no'
}

/** 插件保存窗口里「存到哪个文件夹」的选项，按文件夹树的顺序排好 */
export interface SaveTarget {
  id: string
  name: string
  /** 第几层，顶层是 0 */
  depth: number
}

/** 存完以后在插件窗口里改文件夹和标签 */
export interface SavedPatch {
  addFolder?: string
  removeFolder?: string
  addTags?: string[]
  removeTags?: string[]
}

/** 导入时需要告诉用户的事 */
export type ImportNotice =
  | { kind: 'same_file'; paperId: string; title: string }
  | { kind: 'same_paper'; token: string; fileName: string; existing: { id: string; title: string; venue?: string; year?: number; files: number } }
  | { kind: 'not_pdf'; fileName: string }
  | { kind: 'failed'; fileName: string; message: string }
  /** 拖进来的 PDF 直接配给了库里还没有文件的那条 */
  | { kind: 'attached'; paperId: string; title: string }
  /** 不像论文（书、扫描件）又没查到详情：问用户要不要让 AI 看前几页来识别 */
  | { kind: 'unidentified'; paperId: string; fileName: string }
  | { kind: 'download_failed'; paperId: string; title: string; message: string }
  /** 从 BibTeX（Zotero 等）导入完：新加几篇、库里已有几篇、找不到的 PDF 几个 */
  | { kind: 'bib_done'; added: number; existing: number; missingFiles: number }

/** 下载文件（PDF） */
export type FetchBytes = (url: string) => Promise<{ status: number; body: Uint8Array }>

/** 读 PDF 时发现不是 PDF */
export class NotAPdfError extends Error {}

/** 按内容哈希存 PDF 的地方 */
export interface PdfStore {
  put(data: Uint8Array, hash: string): Promise<unknown>
}

/** 路径里的文件名；/ 和 \ 都认（Windows 路径也能用） */
export function baseName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path
}

/** 文字里的第一个 http(s) 链接 */
export function urlIn(text: string): string | null {
  const m = /https?:\/\/[^\s<>"'）】]+/i.exec(text)
  if (!m) return null
  const url = m[0].replace(/[.,;:!?)\]，。；：！？]+$/, '')
  try {
    new URL(url)
    return url
  } catch {
    return null
  }
}

/** 链接里的文件名，当作导入文件的原名；看不出来就用 download.pdf */
export function fileNameFromUrl(url: string): string {
  let name = ''
  try {
    name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
  } catch {
    // 编码不对就不要了
  }
  name = name.replace(/[\\/:*?"<>|]+/g, '_').trim()
  if (!name) return 'download.pdf'
  return /\.pdf$/i.test(name) ? name : name + '.pdf'
}

/** PDF 文件头（%PDF-）在开头 1 KB 里就算是 PDF */
function isPdf(b: Uint8Array): boolean {
  const head = String.fromCharCode(...b.subarray(0, 1024))
  return head.includes('%PDF-')
}

interface PendingDuplicate {
  existingId: string
  file: FileRef
}

export interface ImporterDeps {
  library: Library
  store: PdfStore
  fetchText: FetchText
  /** 下载 PDF 用；不给就不自动下载 */
  fetchBytes?: FetchBytes
  onChanged: () => void
  onNotice: (n: ImportNotice) => void
  /** 读用户选的文件 */
  read: (path: string) => Promise<Uint8Array>
  /** SHA-256，十六进制 */
  hash: (data: Uint8Array) => string | Promise<string>
  /** 读 PDF 前两页的文字和自带信息；不是 PDF 时抛 NotAPdfError */
  pdfFacts: (data: Uint8Array, fileName: string) => Promise<PdfFacts>
  now?: () => string
}

export class Importer {
  private queue: { id: string; facts: PdfFacts }[] = []
  private running = false
  private idle: Promise<void> = Promise.resolve()
  private importing = new Set<string>()
  private downloading = new Map<string, Promise<void>>()
  private pending = new Map<string, PendingDuplicate>()
  /** 攒着的"要不要让 AI 识别"：等这一批导入和联网查询都做完再一起问，免得对话框弹出来以后还在变 */
  private held: ImportNotice[] = []
  private batches = 0
  private now: () => string

  constructor(private d: ImporterDeps) {
    this.now = d.now ?? (() => new Date().toISOString())
  }

  private read(path: string): Promise<Uint8Array> {
    return this.d.read(path)
  }

  private async sha256(data: Uint8Array): Promise<string> {
    return this.d.hash(data)
  }

  private readPdfFacts(data: Uint8Array, fileName: string): Promise<PdfFacts> {
    return this.d.pdfFacts(data, fileName)
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
    this.batches++
    try {
      for (const p of paths) {
        try {
          await this.importOne(baseName(p), await this.read(p))
        } catch (e) {
          this.d.onNotice({ kind: 'failed', fileName: baseName(p), message: e instanceof Error ? e.message : String(e) })
        }
      }
    } finally {
      this.batches--
    }
    this.d.onChanged()
    this.kick()
    this.flushHeld()
  }

  /** 导入一个 PDF。返回它落到了库里哪一篇（新加的，还是已有的）；不是 PDF 时返回 null */
  private async importOne(fileName: string, data: Uint8Array): Promise<{ paperId: string; status: 'added' | 'existing' } | null> {
    const hash = await this.sha256(data)
    const lib = this.d.library

    const same = lib.findDuplicate({ hash })
    if (same) {
      this.d.onNotice({ kind: 'same_file', paperId: same.paper.id, title: same.paper.title })
      return { paperId: same.paper.id, status: 'existing' }
    }
    let facts: PdfFacts
    try {
      facts = await this.readPdfFacts(data, fileName)
    } catch (e) {
      if (e instanceof NotAPdfError) {
        this.d.onNotice({ kind: 'not_pdf', fileName })
        return null
      }
      throw e
    }
    const file = await this.storeFile(data, hash, facts, fileName)

    // 编号能直接对上库里的论文：不用等联网，马上问用户
    const ids = findIdentifiers(facts)
    const known = lib.findDuplicate(ids)
    if (known) {
      this.askDuplicate(known.paper.id, file)
      return { paperId: known.paper.id, status: 'existing' }
    }

    const guess = guessFromPdf(facts)
    const p = lib.addPaper({ ...guess, identifiers: { ...guess.identifiers, ...ids } }, { file, needsMatch: true, matchIssue: ids.arxiv || ids.doi || ids.isbn ? 'lookup_failed' : 'no_id' })
    if (ids.arxiv || ids.doi || ids.isbn) {
      this.importing.add(p.id)
      this.queue.push({ id: p.id, facts })
    } else this.offerAi(p.id, facts, guess)
    return { paperId: p.id, status: 'added' }
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
          hash = await this.sha256(data)
          const same = lib.findDuplicate({ hash })
          if (same) break
          const facts = await this.readPdfFacts(data, baseName(path))
          file = await this.storeFile(data, hash, facts, baseName(path))
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
    const hash = await this.sha256(data)
    const other = this.d.library.findDuplicate({ hash }, paperId)
    if (other && other.reason === 'file') return 'other_paper'
    let facts: PdfFacts
    try {
      facts = await this.readPdfFacts(data, baseName(path))
    } catch (e) {
      if (e instanceof NotAPdfError) return 'not_pdf'
      throw e
    }
    this.d.library.replaceMainFile(paperId, await this.storeFile(data, hash, facts, baseName(path)))
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
      this.flushHeld()
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
    if (r.needsMatch) {
      // 联网失败的不问：重试就能查到，用不着 AI
      if (r.matchIssue !== 'lookup_failed') this.offerAi(id, facts, r.meta)
      return
    }
    const dup = lib.findDuplicate({ ...r.meta.identifiers, title: r.meta.title }, id)
    if (dup) {
      // 查完才发现是库里已有的论文：撤回刚建的记录，问用户要不要作为另一个版本
      const file = paper.files[0]
      lib.removePaper(id)
      if (file) this.askDuplicate(dup.paper.id, file)
    }
  }

  /**
   * 没查到详情的书和扫描件：连标题都只能用文件名的，或者是书但 PDF 里没写作者的。
   * 论文不问：按标题搜索更准，也不花钱。
   */
  private offerAi(paperId: string, facts: PdfFacts, guess: PaperMeta): void {
    if (guess.source !== 'filename' && !(facts.pageCount >= BOOK_PAGES && guess.authors.length === 0)) return
    this.held.push({ kind: 'unidentified', paperId, fileName: facts.fileName })
    this.flushHeld()
  }

  private flushHeld(): void {
    if (this.batches > 0 || this.running || this.queue.length) return
    for (const n of this.held.splice(0)) this.d.onNotice(n)
  }

  /**
   * 用上 AI 从前几页读出来的信息。AI 读到了 DOI 或 ISBN 就再联网查一次，查到的更可靠；查不到用 AI 读的。
   * 等待期间用户自己改过就不动。
   */
  async applyIdentified(id: string, meta: PaperMeta): Promise<void> {
    this.importing.add(id)
    this.d.onChanged()
    try {
      const ids = meta.identifiers
      const text = ids.doi ?? (ids.isbn ? `ISBN ${ids.isbn}` : '')
      const found = text ? await identifyText(text, this.d.fetchText).catch(() => null) : null
      const p = this.d.library.getPaper(id)
      if (!p || p.metadataSource === 'user') return
      this.d.library.applyMeta(id, found && !found.needsMatch ? found.meta : meta, { needsMatch: false })
    } finally {
      this.importing.delete(id)
      this.d.onChanged()
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

  /**
   * 粘贴 DOI、arXiv 链接或书的 ISBN：建一条没有 PDF 的记录。
   * 都没有但贴的是链接：当作 PDF 下载下来导入。什么都没认出来返回 false
   */
  async addFromText(text: string): Promise<boolean> {
    const ids = idsInText(text)
    if (!ids.arxiv && !ids.doi && !ids.isbn) {
      const url = urlIn(text)
      if (!url) return false
      await this.addFromUrl(url)
      return true
    }
    const known = this.d.library.findDuplicate(ids)
    if (known) {
      this.d.onNotice({ kind: 'same_file', paperId: known.paper.id, title: known.paper.title })
      if (known.paper.files.length === 0) this.startDownload(known.paper.id)
      return true
    }
    const p = this.d.library.addPaper({ title: idLabel(ids), authors: [], identifiers: ids, source: 'user' }, { needsMatch: true, matchIssue: 'lookup_failed' })
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

  /** 插件问：这个网页上的论文库里有没有 */
  findPage(page: PageInfo): PageResult | null {
    const ids = pageIds(page)
    const meta = pageMeta(page, ids)
    const known = this.d.library.findDuplicate({ ...ids, ...(meta ? { title: meta.title } : {}) })
    return known ? this.pageResult(known.paper) : null
  }

  /**
   * 插件点了保存：按网页上的编号建一条记录，联网查详情（查不到就用网页上的信息），arXiv 的再在后台下 PDF。
   * 库里已有就不重复加（没有 PDF 的话顺便去下）。网页上既没有编号也没有标题时返回 null。
   */
  async addFromPage(page: PageInfo): Promise<(PageResult & { status: 'added' | 'existing' }) | null> {
    const lib = this.d.library
    const ids = pageIds(page)
    // 直接打开的 PDF：就存这个文件。arXiv 的除外，按编号存详情更全，PDF 照样从 arXiv 下
    if (page.isPdf === true && !ids.arxiv) return this.addPdfFromPage(String(page.url), ids)
    const meta = pageMeta(page, ids)
    const hasId = !!(ids.arxiv || ids.doi)
    if (!hasId && !meta) return null
    const known = lib.findDuplicate({ ...ids, ...(meta ? { title: meta.title } : {}) })
    if (known) {
      if (known.paper.files.length === 0) this.startDownload(known.paper.id)
      return { ...this.pageResult(lib.getPaper(known.paper.id) ?? known.paper), status: 'existing' }
    }
    const base: PaperMeta = meta ?? { title: idLabel(ids), authors: [], identifiers: ids, source: 'web' }
    // 网页信息够用（有标题和作者）就不标"需要匹配"；联网查到了会再换成查到的
    const enough = !!meta && meta.authors.length > 0
    const p = lib.addPaper(base, enough ? { needsMatch: false } : { needsMatch: true, matchIssue: hasId ? 'lookup_failed' : 'no_id' })
    if (hasId) {
      this.importing.add(p.id)
      this.d.onChanged()
      try {
        const text = [ids.arxiv && `arXiv:${ids.arxiv}`, ids.doi].filter(Boolean).join(' ')
        const r = await identifyText(text, this.d.fetchText).catch(() => null)
        const now = lib.getPaper(p.id)
        if (r && !r.needsMatch && now && now.metadataSource !== 'user') lib.applyMeta(p.id, r.meta, { needsMatch: false })
        else if (r?.matchIssue && now && !enough) lib.applyMeta(p.id, { ...base, identifiers: { ...base.identifiers, ...r.meta.identifiers } }, { needsMatch: true, matchIssue: r.matchIssue })
      } finally {
        this.importing.delete(p.id)
      }
    }
    this.d.onChanged()
    this.startDownload(p.id)
    const saved = lib.getPaper(p.id)
    return saved ? { ...this.pageResult(saved), status: 'added' } : null
  }

  /** 插件在 PDF 标签页上点了保存：Flax 自己下载这个网址，和拖进来的文件一样导入。下载失败就报错，插件小窗里显示 */
  private async addPdfFromPage(url: string, ids: FoundIds): Promise<PageResult & { status: 'added' | 'existing' }> {
    const lib = this.d.library
    const known = ids.doi ? lib.findDuplicate(ids) : null
    if (known && known.paper.files.length > 0) return { ...this.pageResult(known.paper), status: 'existing' }
    return this.addPdfData(await this.fetchPdf(url), fileNameFromUrl(url))
  }

  /**
   * 插件在浏览器里下好的 PDF（带着用户的登录状态）。给了 paperId 就配到那一篇上（那篇已经有 PDF 时不动）；
   * 没给就和拖进来的文件一样导入（直接打开的 PDF 标签页）。
   */
  async addPdfData(data: Uint8Array, fileName: string, paperId?: string): Promise<PageResult & { status: 'added' | 'existing' }> {
    const lib = this.d.library
    if (!isPdf(data)) throw new Error('下载到的不是 PDF。')
    if (paperId) {
      const p = lib.getPaper(paperId)
      if (!p) throw new Error('这一篇已经不在文献库里了。')
      if (p.files.length === 0) await this.attach(paperId, data, fileName)
      this.d.onChanged()
      return { ...this.pageResult(lib.getPaper(paperId) ?? p), status: 'existing' }
    }
    this.batches++
    let r: { paperId: string; status: 'added' | 'existing' } | null
    try {
      r = await this.importOne(fileName, data)
    } finally {
      this.batches--
    }
    this.d.onChanged()
    this.kick()
    this.flushHeld()
    const saved = r && lib.getPaper(r.paperId)
    if (!r || !saved) throw new Error('这个 PDF 读不出来。')
    return { ...this.pageResult(saved), status: r.status }
  }

  /** 把 PDF 配到一篇还没有 PDF 的论文上。同一个文件已经是别的论文的，就提示一下不配 */
  private async attach(id: string, data: Uint8Array, fileName: string): Promise<boolean> {
    let facts: PdfFacts
    try {
      facts = await this.readPdfFacts(data, fileName)
    } catch (e) {
      if (e instanceof NotAPdfError) throw new Error('下载到的不是 PDF。')
      throw e
    }
    const paper = this.d.library.getPaper(id)
    if (!paper || paper.files.length > 0) return false
    const hash = await this.sha256(data)
    const other = this.d.library.findDuplicate({ hash })
    if (other && other.paper.id !== id) {
      this.d.onNotice({ kind: 'same_file', paperId: other.paper.id, title: other.paper.title })
      return false
    }
    this.d.library.addFile(id, await this.storeFile(data, hash, facts, fileName))
    return true
  }

  /**
   * 网页上没下到 PDF：Flax 自己找免费的版本。arXiv 的从 arXiv 下；有 DOI 的问 OpenAlex 有没有开放获取的 PDF。
   * 等下载结束再返回，找不到不算出错（返回 pdf: 'no'）。
   */
  async findOpenPdf(paperId: string): Promise<PageResult> {
    const lib = this.d.library
    const p = lib.getPaper(paperId)
    if (!p) throw new Error('这一篇已经不在文献库里了。')
    if (p.files.length === 0 && !this.startDownload(paperId) && p.identifiers.doi && this.d.fetchBytes) {
      const job = this.downloadOpenAccess(paperId, p.identifiers.doi).finally(() => {
        this.downloading.delete(paperId)
        this.d.onChanged()
      })
      this.downloading.set(paperId, job)
      this.d.onChanged()
    }
    await this.downloading.get(paperId)
    return this.pageResult(lib.getPaper(paperId) ?? p)
  }

  private async downloadOpenAccess(id: string, doi: string): Promise<void> {
    for (const url of await openAccessPdfs(doi, this.d.fetchText)) {
      try {
        const data = await this.fetchPdf(url)
        await this.attach(id, data, fileNameFromUrl(url))
        return
      } catch {
        // 换下一个地址
      }
    }
  }

  /** 插件保存窗口里的文件夹列表（按树的顺序，带层级）和已有的标签 */
  saveTargets(): { folders: SaveTarget[]; tags: string[] } {
    const lib = this.d.library
    const all = lib.listFolders()
    const byParent = new Map<string, typeof all>()
    for (const f of all) {
      const key = f.parentId && all.some((x) => x.id === f.parentId) ? f.parentId : ''
      byParent.set(key, [...(byParent.get(key) ?? []), f])
    }
    const folders: SaveTarget[] = []
    const walk = (parent: string, depth: number) => {
      for (const f of (byParent.get(parent) ?? []).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))) {
        folders.push({ id: f.id, name: f.name, depth })
        walk(f.id, depth + 1)
      }
    }
    walk('', 0)
    return { folders, tags: lib.listTags().map((t) => t.tag) }
  }

  /** 插件保存窗口里换了文件夹、加减了标签 */
  updateSaved(paperId: string, patch: SavedPatch): PageResult {
    const lib = this.d.library
    const p = lib.getPaper(paperId)
    if (!p) throw new Error('这一篇已经不在文献库里了。')
    const known = new Set(lib.listFolders().map((f) => f.id))
    const str = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 100) : '')
    const list = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean).slice(0, 50) : [])
    let folderIds = p.folderIds.filter((f) => f !== str(patch.removeFolder))
    const add = str(patch.addFolder)
    if (add && known.has(add)) folderIds = [...folderIds, add]
    const remove = new Set(list(patch.removeTags))
    const tags = [...p.tags.filter((t) => !remove.has(t)), ...list(patch.addTags)]
    lib.updatePaper(paperId, { folderIds, tags })
    this.d.onChanged()
    return this.pageResult(lib.getPaper(paperId)!)
  }

  /** 下载网址上的 PDF。出错时的消息直接给用户看 */
  private async fetchPdf(url: string): Promise<Uint8Array> {
    if (!/^https?:\/\//i.test(url)) throw new Error('只能下载 http 和 https 的链接。')
    if (!this.d.fetchBytes) throw new Error('这里不能从链接下载，请下载后选择文件添加。')
    let res: Awaited<ReturnType<FetchBytes>>
    try {
      res = await this.d.fetchBytes(url)
    } catch (e) {
      throw new Error(e instanceof Error && e.message === '文件太大' ? '文件超过 200 MB，请下载后选择文件添加。' : '下载失败，请检查链接和网络。')
    }
    if (res.status === 401 || res.status === 403) throw new Error('这个 PDF 要登录才能下载，Flax 下不到。请在浏览器里下载后拖进 Flax。')
    if (res.status !== 200) throw new Error(res.status === 404 ? '链接打不开（404）。' : `下载失败（服务器返回 ${res.status}）。`)
    if (!isPdf(res.body)) throw new Error('链接打开的不是 PDF。网页上的论文请找到 PDF 链接，或下载后选择文件添加。')
    return res.body
  }

  private pageResult(p: Paper): PageResult {
    const pdf = p.files.length > 0 ? 'yes' : this.downloading.has(p.id) ? 'downloading' : 'no'
    return { paperId: p.id, title: p.title, hasPdf: pdf !== 'no', pdf }
  }

  /** 下载链接指向的 PDF，和选文件导入一样处理（查重、联网查详情）。出错用通知告诉用户 */
  private async addFromUrl(url: string): Promise<void> {
    const fileName = fileNameFromUrl(url)
    const fail = (message: string) => this.d.onNotice({ kind: 'failed', fileName, message })
    let body: Uint8Array
    try {
      body = await this.fetchPdf(url)
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
    this.batches++
    try {
      await this.importOne(fileName, body)
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e))
    } finally {
      this.batches--
    }
    this.d.onChanged()
    this.kick()
    this.flushHeld()
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
        facts = await this.readPdfFacts(res.body, fileName)
      } catch (e) {
        if (e instanceof NotAPdfError) throw new Error('arXiv 返回的不是 PDF')
        throw e
      }
      const paper = this.d.library.getPaper(id)
      // 下载期间被删了，或者用户已经拖了文件进来
      if (!paper || paper.files.length > 0) return
      const hash = await this.sha256(res.body)
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
    const text = [p.identifiers.arxiv && `arXiv:${p.identifiers.arxiv}`, p.identifiers.doi].filter(Boolean).join(' ') || (p.identifiers.isbn ? `ISBN ${p.identifiers.isbn}` : '')
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

/** 网页上的编号：先用插件找到的，再看网址。都按粘贴文字的规则认一遍，格式不对的丢掉 */
function pageIds(page: PageInfo): FoundIds {
  const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 300) : '')
  const arxiv = str(page.ids?.arxiv)
  const given = idsInText([arxiv && `arXiv:${arxiv.replace(/^arxiv:/i, '')}`, str(page.ids?.doi)].join(' '))
  const fromUrl = idsInText(str(page.url))
  const out: FoundIds = {}
  const a = given.arxiv ?? fromUrl.arxiv
  const d = given.doi ?? fromUrl.doi
  if (a) out.arxiv = a
  if (d) out.doi = d
  return out
}

/** 网页上的 citation_* 信息；没有标题就是 null */
function pageMeta(page: PageInfo, ids: FoundIds): PaperMeta | null {
  const m = page.meta
  const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
  const title = clean(m?.title, 1000)
  if (!title) return null
  const names = Array.isArray(m?.authors) ? m!.authors.map((a) => clean(a, 200)).filter(Boolean) : []
  const meta: PaperMeta = { title, authors: [...new Set(names)].slice(0, 500).map(splitName), identifiers: { ...ids }, source: 'web' }
  const year = Number(m?.year)
  if (Number.isInteger(year) && year > 1000 && year < 3000) meta.year = year
  const venue = clean(m?.venue, 300)
  if (venue) meta.venue = venue
  const abstract = clean(m?.abstract, 10_000)
  if (abstract) meta.abstract = abstract
  return meta
}

/** OpenAlex 记录的开放获取 PDF 地址（最好的那个在前）。查不到、没有就是空的 */
async function openAccessPdfs(doi: string, fetchText: FetchText): Promise<string[]> {
  let r: { status: number; body: string }
  try {
    r = await fetchText(`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`)
  } catch {
    return []
  }
  if (r.status !== 200) return []
  try {
    const w = JSON.parse(r.body) as { best_oa_location?: { pdf_url?: unknown } | null; locations?: { pdf_url?: unknown; is_oa?: unknown }[] }
    const urls = [w.best_oa_location?.pdf_url, ...(w.locations ?? []).filter((l) => l?.is_oa).map((l) => l.pdf_url)]
    return [...new Set(urls.filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u)))].slice(0, 3)
  } catch {
    return []
  }
}
