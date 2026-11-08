// 文献库仓储层：所有读写都经过这里。
// 每条记录存成 JSON，另抽几列做索引。以后接 CRDT 同步只改这一层。
import type { Annotation, FileRef, Folder, MatchIssue, Paper, PaperMeta, ReadingStatus, TagColor, Term, UUID } from './model'
import { TAG_COLORS } from './model'
import { normalizeTitle } from './text'
import { createLibrarySyncStore, LIBRARY_SYNC_SCHEMA } from './sync/libraryStore'
import type { SyncStore } from './sync/store'

// Node、浏览器和 React Native（加 polyfill）都有全局 crypto.randomUUID
declare const crypto: { randomUUID(): string }

/** 和 node:sqlite 的 DatabaseSync 形状一致；移动端换成别的驱动时实现同样的接口 */
export interface SqlDb {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: SqlValue[]): unknown
    get(...params: SqlValue[]): unknown
    all(...params: SqlValue[]): unknown[]
  }
}
export type SqlValue = string | number | null

export interface LibraryOptions {
  now?: () => string
  uuid?: () => string
}

export type DuplicateReason = 'file' | 'doi' | 'arxiv' | 'title'

export type PaperPatch = Partial<
  Pick<Paper, 'title' | 'authors' | 'year' | 'venue' | 'abstract' | 'identifiers' | 'readingStatus' | 'rating' | 'tags' | 'folderIds' | 'lastOpenedAt' | 'readingPosition'>
>

const METADATA_KEYS = ['title', 'authors', 'year', 'venue', 'abstract', 'identifiers'] as const

const SCHEMA_VERSION = 4

export type NewAnnotation = Omit<Annotation, 'id' | 'updatedAt' | 'deviceId' | 'createdAt'>
export type AnnotationPatch = Partial<Pick<Annotation, 'color' | 'type' | 'comment'>>

export class Library {
  readonly deviceId: string
  private now: () => string
  private uuid: () => string

  constructor(private db: SqlDb, opts: LibraryOptions = {}) {
    this.now = opts.now ?? (() => new Date().toISOString())
    this.uuid = opts.uuid ?? (() => crypto.randomUUID())
    this.migrate()
    this.deviceId = this.ensureDeviceId()
  }

  private migrate(): void {
    const v = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (v >= SCHEMA_VERSION) return
    this.tx(() => {
      if (v < 1) this.db.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS papers (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          title_norm TEXT NOT NULL,
          doi TEXT,
          arxiv TEXT,
          added_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS papers_doi ON papers(doi);
        CREATE INDEX IF NOT EXISTS papers_arxiv ON papers(arxiv);
        CREATE INDEX IF NOT EXISTS papers_title ON papers(title_norm);
        CREATE TABLE IF NOT EXISTS files (hash TEXT PRIMARY KEY, paper_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS folders (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted INTEGER NOT NULL DEFAULT 0
        );
      `)
      if (v < 2) this.db.exec(`
        CREATE TABLE IF NOT EXISTS annotations (
          id TEXT PRIMARY KEY,
          paper_id TEXT NOT NULL,
          file_hash TEXT NOT NULL,
          data TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS annotations_paper ON annotations(paper_id);
      `)
      if (v < 3) this.db.exec(`
        CREATE TABLE IF NOT EXISTS terms (
          id TEXT PRIMARY KEY,
          term_norm TEXT NOT NULL,
          data TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS terms_norm ON terms(term_norm);
      `)
      if (v < 4) {
        // 标签颜色原来是 meta 里的一个 JSON，两台设备各改一个颜色会互相覆盖；拆成每个标签一行
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS tag_colors (
            id TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0
          );
          ${LIBRARY_SYNC_SCHEMA}
        `)
        const row = this.db.prepare("SELECT value FROM meta WHERE key = 'tagColors'").get() as { value: string } | undefined
        let old: Record<string, unknown> = {}
        try {
          old = row ? (JSON.parse(row.value) as Record<string, unknown>) : {}
        } catch {
          /* 读不懂就不要了 */
        }
        const now = this.now()
        for (const [tag, color] of Object.entries(old)) {
          if (TAG_COLORS.includes(color as TagColor)) this.db.prepare('INSERT OR REPLACE INTO tag_colors (id, data, updated_at) VALUES (?, ?, ?)').run(tag, JSON.stringify({ id: tag, color }), now)
        }
        this.db.prepare("DELETE FROM meta WHERE key = 'tagColors'").run()
      }
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    })
  }

  private ensureDeviceId(): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'deviceId'").get() as { value: string } | undefined
    if (row) return row.value
    const id = this.uuid()
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('deviceId', ?)").run(id)
    return id
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const r = fn()
      this.db.exec('COMMIT')
      return r
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  // —— 同步 ——

  /** 给同步引擎用的接口（见 sync/libraryStore.ts） */
  syncStore(): SyncStore {
    return createLibrarySyncStore(this.db, this.deviceId, (fn) => this.tx(fn), this.now)
  }

  /** 已经传到云端的 PDF（按哈希） */
  syncedFiles(): Set<string> {
    return new Set((this.db.prepare('SELECT hash FROM sync_files').all() as { hash: string }[]).map((r) => r.hash))
  }

  markFileSynced(hash: string): void {
    this.db.prepare('INSERT OR IGNORE INTO sync_files (hash) VALUES (?)').run(hash)
  }

  /** 换了同步库：所有 PDF 都要重新传 */
  forgetSyncedFiles(): void {
    this.db.prepare('DELETE FROM sync_files').run()
  }

  /** 所有没删的论文用到的 PDF 哈希 */
  liveFileHashes(): string[] {
    const out = new Set<string>()
    for (const p of this.listPapers()) for (const f of p.files) out.add(f.hash)
    return [...out]
  }

  /** 同步引擎自己的状态（读到哪了、本机时钟）也记在 meta 表里 */
  metaGet(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  metaSet(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM meta WHERE key = ?').run(key)
    else this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  // —— 论文 ——

  listPapers(): Paper[] {
    const rows = this.db.prepare('SELECT data FROM papers WHERE deleted = 0 ORDER BY added_at DESC').all() as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as Paper)
  }

  getPaper(id: UUID): Paper | null {
    const row = this.db.prepare('SELECT data FROM papers WHERE id = ? AND deleted = 0').get(id) as { data: string } | undefined
    return row ? (JSON.parse(row.data) as Paper) : null
  }

  /** 按文件哈希、DOI、arXiv 编号、标题依次找库里已有的同一篇 */
  findDuplicate(q: { hash?: string; doi?: string; arxiv?: string; title?: string }, exceptId?: UUID): { paper: Paper; reason: DuplicateReason } | null {
    const pick = (sql: string, v: string, reason: DuplicateReason) => {
      const rows = this.db.prepare(sql).all(v) as { data: string }[]
      const p = rows.map((r) => JSON.parse(r.data) as Paper).find((x) => x.id !== exceptId)
      return p ? { paper: p, reason } : null
    }
    const live = 'SELECT p.data FROM papers p'
    if (q.hash) {
      const r = pick(`${live} JOIN files f ON f.paper_id = p.id WHERE f.hash = ? AND p.deleted = 0`, q.hash, 'file')
      if (r) return r
    }
    if (q.doi) {
      const r = pick(`${live} WHERE p.doi = ? AND p.deleted = 0`, q.doi.toLowerCase(), 'doi')
      if (r) return r
    }
    if (q.arxiv) {
      const r = pick(`${live} WHERE p.arxiv = ? AND p.deleted = 0`, q.arxiv, 'arxiv')
      if (r) return r
    }
    // 标题太短容易误判（例如 "Introduction"），只比较足够长的标题
    const t = q.title ? normalizeTitle(q.title) : ''
    if (t.length >= 20) {
      const r = pick(`${live} WHERE p.title_norm = ? AND p.deleted = 0`, t, 'title')
      if (r) return r
    }
    return null
  }

  addPaper(meta: PaperMeta, opts: { file?: FileRef; needsMatch?: boolean; matchIssue?: MatchIssue; readingStatus?: ReadingStatus; batch?: boolean } = {}): Paper {
    const now = this.now()
    const p: Paper = {
      id: this.uuid(),
      updatedAt: now,
      deviceId: this.deviceId,
      title: meta.title,
      authors: meta.authors,
      identifiers: meta.identifiers,
      files: opts.file ? [opts.file] : [],
      folderIds: [],
      tags: [],
      readingStatus: opts.readingStatus ?? 'inbox',
      addedAt: now,
      metadataSource: meta.source,
      needsMatch: opts.needsMatch ?? false
    }
    if (meta.year !== undefined) p.year = meta.year
    if (meta.venue !== undefined) p.venue = meta.venue
    if (meta.abstract !== undefined) p.abstract = meta.abstract
    if (opts.matchIssue && p.needsMatch) p.matchIssue = opts.matchIssue
    if (opts.batch) p.batch = true
    this.tx(() => {
      this.db
        .prepare('INSERT INTO papers (id, data, title_norm, doi, arxiv, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(p.id, JSON.stringify(p), normalizeTitle(p.title), p.identifiers.doi ?? null, p.identifiers.arxiv ?? null, p.addedAt, p.updatedAt)
      if (opts.file) this.db.prepare('INSERT OR REPLACE INTO files (hash, paper_id) VALUES (?, ?)').run(opts.file.hash, p.id)
    })
    return p
  }

  /** 识别结果回来后整体替换元数据 */
  applyMeta(id: UUID, meta: PaperMeta, opts: { needsMatch: boolean; matchIssue?: MatchIssue }): Paper {
    return this.write(id, (p) => {
      p.title = meta.title
      p.authors = meta.authors
      p.identifiers = { ...p.identifiers, ...meta.identifiers }
      setOpt(p, 'year', meta.year)
      setOpt(p, 'venue', meta.venue)
      setOpt(p, 'abstract', meta.abstract)
      p.metadataSource = meta.source
      p.needsMatch = opts.needsMatch
      setOpt(p, 'matchIssue', opts.needsMatch ? opts.matchIssue : undefined)
    })
  }

  updatePaper(id: UUID, patch: PaperPatch): Paper {
    return this.write(id, (p) => {
      const touchesMeta = METADATA_KEYS.some((k) => k in patch)
      for (const [k, v] of Object.entries(patch) as [keyof PaperPatch, unknown][]) {
        if (v === undefined || v === null || v === '') delete (p as unknown as Record<string, unknown>)[k]
        else (p as unknown as Record<string, unknown>)[k] = v
      }
      if (patch.tags) p.tags = cleanTags(patch.tags)
      if (patch.folderIds) p.folderIds = [...new Set(patch.folderIds)]
      if (!p.title) p.title = '未命名论文'
      if (!p.authors) p.authors = []
      if (!p.identifiers) p.identifiers = {}
      // 用户手动改过元数据，就不再提示"需要匹配"
      if (touchesMeta) {
        p.metadataSource = 'user'
        p.needsMatch = false
        delete p.matchIssue
      }
    })
  }

  addFile(id: UUID, file: FileRef): Paper {
    return this.tx(() => {
      const p = this.write(id, (x) => {
        x.files = [...x.files.filter((f) => f.hash !== file.hash), file]
      })
      this.db.prepare('INSERT OR REPLACE INTO files (hash, paper_id) VALUES (?, ?)').run(file.hash, id)
      return p
    })
  }

  /** 主文件找不到了，用户重新选了一个：它成为主文件，原来的主文件记录去掉 */
  replaceMainFile(id: UUID, file: FileRef): Paper {
    return this.tx(() => {
      const p = this.write(id, (x) => {
        x.files = [{ ...file, role: 'main' }, ...x.files.filter((f) => f.hash !== file.hash && f.role !== 'main')]
      })
      this.db.prepare('INSERT OR REPLACE INTO files (hash, paper_id) VALUES (?, ?)').run(file.hash, id)
      return p
    })
  }

  /** 软删除：保留记录，同步时作为删除标记；可以撤销 */
  removePaper(id: UUID): void {
    this.db.prepare('UPDATE papers SET deleted = 1, updated_at = ? WHERE id = ?').run(this.now(), id)
  }

  restorePaper(id: UUID): void {
    this.db.prepare('UPDATE papers SET deleted = 0, updated_at = ? WHERE id = ?').run(this.now(), id)
  }

  private write(id: UUID, fn: (p: Paper) => void): Paper {
    const p = this.getPaper(id)
    if (!p) throw new Error(`paper not found: ${id}`)
    fn(p)
    p.updatedAt = this.now()
    p.deviceId = this.deviceId
    this.db
      .prepare('UPDATE papers SET data = ?, title_norm = ?, doi = ?, arxiv = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(p), normalizeTitle(p.title), p.identifiers.doi?.toLowerCase() ?? null, p.identifiers.arxiv ?? null, p.updatedAt, id)
    return p
  }

  // —— 文件夹 ——

  listFolders(): Folder[] {
    const rows = this.db.prepare('SELECT data FROM folders WHERE deleted = 0').all() as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as Folder).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  }

  createFolder(name: string, parentId?: UUID): Folder {
    const n = name.trim()
    if (!n) throw new Error('folder name is empty')
    const order = this.listFolders().reduce((m, f) => Math.max(m, f.order + 1), 0)
    const f: Folder = { id: this.uuid(), updatedAt: this.now(), deviceId: this.deviceId, name: n, order }
    if (parentId) f.parentId = parentId
    this.db.prepare('INSERT INTO folders (id, data, updated_at) VALUES (?, ?, ?)').run(f.id, JSON.stringify(f), f.updatedAt)
    return f
  }

  renameFolder(id: UUID, name: string): Folder {
    const n = name.trim()
    if (!n) throw new Error('folder name is empty')
    const f = this.listFolders().find((x) => x.id === id)
    if (!f) throw new Error(`folder not found: ${id}`)
    const next: Folder = { ...f, name: n, updatedAt: this.now(), deviceId: this.deviceId }
    this.db.prepare('UPDATE folders SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(next), next.updatedAt, id)
    return next
  }

  /** 删除文件夹只是不再分组，论文本身不动 */
  removeFolder(id: UUID): void {
    this.tx(() => {
      this.db.prepare('UPDATE folders SET deleted = 1, updated_at = ? WHERE id = ?').run(this.now(), id)
      for (const p of this.listPapers()) {
        if (p.folderIds.includes(id)) this.write(p.id, (x) => { x.folderIds = x.folderIds.filter((f) => f !== id) })
      }
    })
  }

  // —— 批注 ——

  /** 一篇论文的批注，按页、再按页内从上到下排 */
  listAnnotations(paperId: UUID): Annotation[] {
    const rows = this.db.prepare('SELECT data FROM annotations WHERE paper_id = ? AND deleted = 0').all(paperId) as { data: string }[]
    const top = (a: Annotation) => Math.max(...a.target.rects.map((r) => Math.max(r[1], r[3])), 0)
    return rows.map((r) => JSON.parse(r.data) as Annotation).sort((a, b) => a.page - b.page || top(b) - top(a) || a.createdAt.localeCompare(b.createdAt))
  }

  /** 按 id 取一条批注（笔记里的引用块跳回原文时用） */
  getAnnotation(id: UUID): Annotation | null {
    const row = this.db.prepare('SELECT data FROM annotations WHERE id = ? AND deleted = 0').get(id) as { data: string } | undefined
    return row ? (JSON.parse(row.data) as Annotation) : null
  }

  /** 每篇论文的批注数，列表里显示 */
  annotationCounts(): Record<UUID, number> {
    const rows = this.db.prepare('SELECT paper_id, COUNT(*) AS n FROM annotations WHERE deleted = 0 GROUP BY paper_id').all() as { paper_id: string; n: number }[]
    return Object.fromEntries(rows.map((r) => [r.paper_id, r.n]))
  }

  addAnnotation(a: NewAnnotation): Annotation {
    if (!a.target.rects.length) throw new Error('annotation has no rects')
    const now = this.now()
    const full: Annotation = { ...a, id: this.uuid(), createdAt: now, updatedAt: now, deviceId: this.deviceId }
    if (!full.comment) delete full.comment
    this.db.prepare('INSERT INTO annotations (id, paper_id, file_hash, data, updated_at) VALUES (?, ?, ?, ?, ?)').run(full.id, full.paperId, full.fileHash, JSON.stringify(full), now)
    return full
  }

  updateAnnotation(id: UUID, patch: AnnotationPatch): Annotation {
    const row = this.db.prepare('SELECT data FROM annotations WHERE id = ? AND deleted = 0').get(id) as { data: string } | undefined
    if (!row) throw new Error(`annotation not found: ${id}`)
    const a = JSON.parse(row.data) as Annotation
    if (patch.color) a.color = patch.color
    if (patch.type) a.type = patch.type
    if ('comment' in patch) setOpt(a, 'comment', patch.comment?.trim() ? patch.comment : undefined)
    a.updatedAt = this.now()
    a.deviceId = this.deviceId
    this.db.prepare('UPDATE annotations SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(a), a.updatedAt, id)
    return a
  }

  /** 软删除，可以撤销 */
  removeAnnotation(id: UUID): void {
    this.db.prepare('UPDATE annotations SET deleted = 1, updated_at = ? WHERE id = ?').run(this.now(), id)
  }

  restoreAnnotation(id: UUID): void {
    this.db.prepare('UPDATE annotations SET deleted = 0, updated_at = ? WHERE id = ?').run(this.now(), id)
  }

  // —— 术语 ——

  /** 全部术语，按原文字母顺序 */
  listTerms(): Term[] {
    const rows = this.db.prepare('SELECT data FROM terms WHERE deleted = 0').all() as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as Term).sort((a, b) => a.term.localeCompare(b.term, 'en', { sensitivity: 'base' }))
  }

  /** 加一条术语；同一个词（不分大小写）已经有了就改它的译法 */
  addTerm(t: { term: string; translation: string; note?: string; paperId?: UUID }): Term {
    const term = t.term.trim().replace(/\s+/g, ' ')
    const translation = t.translation.trim()
    if (!term || !translation) throw new Error('术语和译法都要填')
    const norm = termNorm(term)
    const row = this.db.prepare('SELECT id FROM terms WHERE term_norm = ? AND deleted = 0').get(norm) as { id: string } | undefined
    if (row) return this.updateTerm(row.id, { translation, ...(t.note?.trim() ? { note: t.note } : {}) })
    const now = this.now()
    const full: Term = { id: this.uuid(), term, translation, createdAt: now, updatedAt: now, deviceId: this.deviceId }
    if (t.note?.trim()) full.note = t.note.trim()
    if (t.paperId) full.paperId = t.paperId
    this.db.prepare('INSERT INTO terms (id, term_norm, data, updated_at) VALUES (?, ?, ?, ?)').run(full.id, norm, JSON.stringify(full), now)
    return full
  }

  updateTerm(id: UUID, patch: Partial<Pick<Term, 'term' | 'translation' | 'note'>>): Term {
    const row = this.db.prepare('SELECT data FROM terms WHERE id = ? AND deleted = 0').get(id) as { data: string } | undefined
    if (!row) throw new Error(`term not found: ${id}`)
    const t = JSON.parse(row.data) as Term
    if (patch.term?.trim()) t.term = patch.term.trim().replace(/\s+/g, ' ')
    if (patch.translation?.trim()) t.translation = patch.translation.trim()
    if ('note' in patch) setOpt(t, 'note', patch.note?.trim() ? patch.note.trim() : undefined)
    t.updatedAt = this.now()
    t.deviceId = this.deviceId
    this.db.prepare('UPDATE terms SET data = ?, term_norm = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(t), termNorm(t.term), t.updatedAt, id)
    return t
  }

  removeTerm(id: UUID): void {
    this.db.prepare('UPDATE terms SET deleted = 1, updated_at = ? WHERE id = ?').run(this.now(), id)
  }

  restoreTerm(id: UUID): void {
    this.db.prepare('UPDATE terms SET deleted = 0, updated_at = ? WHERE id = ?').run(this.now(), id)
  }

  /** 这段文字里出现了哪些术语（翻译时告诉模型按这些译法来） */
  termsIn(text: string): Term[] {
    return termsIn(this.listTerms(), text)
  }

  // —— 标签 ——

  listTags(): { tag: string; count: number; color?: TagColor }[] {
    const m = new Map<string, number>()
    for (const p of this.listPapers()) for (const t of p.tags) m.set(t, (m.get(t) ?? 0) + 1)
    const colors = this.tagColors()
    return [...m]
      .map(([tag, count]) => (colors[tag] ? { tag, count, color: colors[tag] } : { tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  }

  /** 标签颜色，每个标签一行（标签本身只是论文上的字符串，没有自己的表） */
  tagColors(): Record<string, TagColor> {
    const rows = this.db.prepare('SELECT id, data FROM tag_colors WHERE deleted = 0').all() as { id: string; data: string }[]
    const out: Record<string, TagColor> = {}
    for (const r of rows) {
      try {
        const c = (JSON.parse(r.data) as { color?: unknown }).color
        if (TAG_COLORS.includes(c as TagColor)) out[r.id] = c as TagColor
      } catch {
        /* 跳过读不懂的 */
      }
    }
    return out
  }

  /** 给标签设颜色；null 去掉颜色（软删除，同步时别的设备也去掉） */
  setTagColor(tag: string, color: TagColor | null): void {
    const now = this.now()
    if (color) {
      this.db
        .prepare('INSERT INTO tag_colors (id, data, updated_at, deleted) VALUES (?, ?, ?, 0) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, deleted = 0')
        .run(tag, JSON.stringify({ id: tag, color }), now)
    } else this.db.prepare('UPDATE tag_colors SET deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0').run(now, tag)
  }

  /** 改名；新名字已存在时就是合并 */
  renameTag(from: string, to: string): number {
    const target = to.trim()
    if (!target) throw new Error('tag is empty')
    let n = 0
    this.tx(() => {
      for (const p of this.listPapers()) {
        if (!p.tags.includes(from)) continue
        this.write(p.id, (x) => { x.tags = cleanTags(x.tags.map((t) => (t === from ? target : t))) })
        n++
      }
      // 颜色跟着走；合并到已有标签时用那个标签自己的颜色
      const c = this.tagColors()
      if (c[from] && !c[target]) this.setTagColor(target, c[from])
      if (c[from] && from !== target) this.setTagColor(from, null)
    })
    return n
  }
}

function cleanTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim().replace(/^#/, '')).filter(Boolean))]
}

function setOpt<T extends object, K extends keyof T>(o: T, k: K, v: T[K] | undefined): void {
  if (v === undefined) delete o[k]
  else o[k] = v
}

function termNorm(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 英文词按词边界匹配（"head" 不匹配 "headline"，复数也算），中日文直接找；不分大小写，连字符和空格换行都算一样 */
export function termsIn(terms: Term[], text: string): Term[] {
  const hay = text.replace(/-\s*\n\s*/g, '').replace(/[\s\u00ad-]+/g, ' ').toLowerCase()
  return terms.filter((t) => {
    const needle = t.term.replace(/[\s-]+/g, ' ').toLowerCase()
    if (!needle) return false
    if (!/^[a-z0-9]/i.test(needle) || !/[a-z0-9]$/i.test(needle)) return hay.includes(needle)
    const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^a-z0-9])${esc}(s|es)?($|[^a-z0-9])`).test(hay)
  })
}
