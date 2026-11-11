// 笔记仓库：notes/ 下的 .md 文件，格式和桌面一样（apps/desktop/src/main/notes.ts）。
// 手机上没有别的编辑器会改这些文件，所以不监听目录；同步写进来以后调 scan()。
import { File } from 'expo-file-system'
import { extractAnnotationRefs, extractLinks, noteExcerpt, parseNote, safeNoteTitle, serializeNote, type NoteDoc, type NoteFiles, type NoteHead } from '@flax/core'
import { notesDir } from './paths'

export interface NoteSummary {
  id: string
  title: string
  paperId?: string
  createdAt: string
  updatedAt: string
  excerpt: string
  links: string[]
  annotationRefs: string[]
}

interface Entry extends NoteSummary {
  file: string
  extra: string[]
  body: string
  hasHead: boolean
}

export class NoteStore {
  private entries = new Map<string, Entry>()

  constructor(private uuid: () => string = () => crypto.randomUUID(), private now: () => string = () => new Date().toISOString()) {
    this.scan()
  }

  scan(): void {
    const next = new Map<string, Entry>()
    if (!notesDir.exists) notesDir.create({ intermediates: true, idempotent: true })
    for (const item of notesDir.list()) {
      if (!(item instanceof File)) continue
      const name = item.name
      if (!name.endsWith('.md') || name.startsWith('.')) continue
      const e = this.load(name)
      if (e && !next.has(e.id)) next.set(e.id, e)
    }
    this.entries = next
  }

  private load(file: string): Entry | null {
    try {
      const f = new File(notesDir, file)
      const text = f.textSync()
      const { head, body, extra } = parseNote(text)
      const mtime = f.modificationTime ? new Date(f.modificationTime).toISOString() : this.now()
      return {
        id: head.id ?? `file:${file}`,
        title: file.slice(0, -3),
        ...(head.paperId ? { paperId: head.paperId } : {}),
        createdAt: head.createdAt ?? (f.creationTime ? new Date(f.creationTime).toISOString() : mtime),
        updatedAt: mtime,
        excerpt: noteExcerpt(body),
        links: extractLinks(body),
        annotationRefs: extractAnnotationRefs(body),
        file,
        extra,
        body,
        hasHead: Boolean(head.id)
      }
    } catch {
      return null
    }
  }

  list(): NoteSummary[] {
    return [...this.entries.values()].map(summary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  read(id: string): { note: NoteSummary; body: string } | null {
    const e = this.entries.get(id)
    return e ? { note: summary(e), body: e.body } : null
  }

  forPaper(paperId: string): NoteSummary[] {
    return this.list().filter((n) => n.paperId === paperId)
  }

  byTitle(title: string): NoteSummary | null {
    const t = title.toLowerCase()
    for (const e of this.entries.values()) if (e.title.toLowerCase() === t) return summary(e)
    return null
  }

  create(opts: { title?: string; paperId?: string; body?: string }): NoteSummary {
    const title = this.freeTitle(safeNoteTitle(opts.title ?? ''))
    const head: NoteHead = { id: this.uuid(), createdAt: this.now(), ...(opts.paperId ? { paperId: opts.paperId } : {}) }
    const file = `${title}.md`
    this.write(file, serializeNote(head, opts.body ?? ''))
    const e = this.load(file)!
    this.entries.set(e.id, e)
    return summary(e)
  }

  save(id: string, body: string): NoteSummary {
    const e = this.must(id)
    const head: NoteHead = { id: e.hasHead ? e.id : this.uuid(), createdAt: e.createdAt, ...(e.paperId ? { paperId: e.paperId } : {}) }
    this.write(e.file, serializeNote(head, body, e.extra))
    const next = this.load(e.file)!
    this.entries.delete(id)
    this.entries.set(next.id, next)
    return summary(next)
  }

  /** 改标题 = 改文件名；别的笔记里的 [[旧标题]] 一起改掉（和桌面一样） */
  rename(id: string, wanted: string): NoteSummary {
    const e = this.must(id)
    const title = safeNoteTitle(wanted)
    if (title === e.title) return summary(e)
    this.entries.delete(id)
    const free = this.freeTitle(title)
    this.entries.set(id, e)
    new File(notesDir, e.file).rename(`${free}.md`)
    const old = e.title
    const pattern = new RegExp(`\\[\\[${escapeRe(old)}(?=[\\]|#])`, 'g')
    for (const other of [...this.entries.values()]) {
      if (other.id === id || !other.links.includes(old)) continue
      const body = other.body.replace(pattern, `[[${free}`)
      if (body !== other.body) this.save(other.id, body)
    }
    this.entries.delete(id)
    const next = this.load(`${free}.md`)!
    this.entries.set(next.id, next)
    return summary(next)
  }

  /** 删掉，返回删之前的内容（给"撤销"用） */
  remove(id: string): NoteDoc | null {
    const e = this.entries.get(id)
    if (!e) return null
    const doc: NoteDoc = { id: e.id, title: e.title, createdAt: e.createdAt, body: e.body, ...(e.paperId ? { paperId: e.paperId } : {}) }
    this.entries.delete(id)
    const f = new File(notesDir, e.file)
    if (f.exists) f.delete()
    return doc
  }

  restore(doc: NoteDoc): void {
    this.syncFiles().put(doc)
  }

  syncFiles(): NoteFiles {
    return {
      all: () => {
        for (const e of [...this.entries.values()]) if (!e.hasHead) this.save(e.id, e.body)
        return [...this.entries.values()].map((e): NoteDoc => ({ id: e.id, title: e.title, createdAt: e.createdAt, body: e.body, ...(e.paperId ? { paperId: e.paperId } : {}) }))
      },
      put: (doc) => {
        const e = this.entries.get(doc.id)
        const head: NoteHead = { id: doc.id, createdAt: doc.createdAt, ...(doc.paperId ? { paperId: doc.paperId } : {}) }
        let file = e?.file
        const wanted = safeNoteTitle(doc.title)
        if (!e || wanted !== e.title) {
          if (e) this.entries.delete(doc.id)
          const free = this.freeTitle(wanted)
          if (e) new File(notesDir, e.file).rename(`${free}.md`)
          file = `${free}.md`
        }
        this.write(file!, serializeNote(head, doc.body, e?.extra ?? []))
        const next = this.load(file!)
        if (next) this.entries.set(next.id, next)
      },
      remove: (id) => {
        const e = this.entries.get(id)
        if (!e) return
        this.entries.delete(id)
        // 别的设备删的。桌面那边进了废纸篓，手机上直接删
        try {
          const f = new File(notesDir, e.file)
          if (f.exists) f.delete()
        } catch (err) {
          console.warn('remove note', err)
        }
      }
    }
  }

  private write(file: string, text: string): void {
    const f = new File(notesDir, file)
    if (!f.exists) f.create({ intermediates: true })
    f.writeSync(text)
  }

  private freeTitle(title: string): string {
    const taken = new Set([...this.entries.values()].map((e) => e.title.toLowerCase()))
    const free = (t: string) => !taken.has(t.toLowerCase()) && !new File(notesDir, `${t}.md`).exists
    if (free(title)) return title
    for (let i = 2; ; i++) if (free(`${title} ${i}`)) return `${title} ${i}`
  }

  private must(id: string): Entry {
    const e = this.entries.get(id)
    if (!e) throw new Error('note not found')
    return e
  }
}

function summary(e: Entry): NoteSummary {
  return { id: e.id, title: e.title, createdAt: e.createdAt, updatedAt: e.updatedAt, excerpt: e.excerpt, links: e.links, annotationRefs: e.annotationRefs, ...(e.paperId ? { paperId: e.paperId } : {}) }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
