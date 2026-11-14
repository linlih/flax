// 笔记仓库：数据目录下 notes/ 里的 .md 文件就是全部数据，没有另外的数据库。
// 用 Obsidian 之类的编辑器直接改文件也可以，这边监听目录变化后重新读。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { extractAnnotationRefs, extractLinks, noteExcerpt, parseNote, safeNoteTitle, serializeNote, type NoteDoc, type NoteFiles, type NoteHead } from '@flax/core'
import type { NoteSummary } from '../shared/api'

interface Entry extends NoteSummary {
  file: string
  extra: string[]
  body: string
  /** 文件里原本有没有头信息；没有的话第一次保存时补上 */
  hasHead: boolean
  /** 文件是什么时候建的（毫秒） */
  born: number
}

export interface NoteStoreDeps {
  uuid?: () => string
  now?: () => string
  /** 删除：桌面端移到系统废纸篓，测试里直接删 */
  trash: (path: string) => Promise<void>
}

export class NoteStore {
  private entries = new Map<string, Entry>()
  private watcher: FSWatcher | null = null
  /** 自己刚写过的文件，监听到变化时跳过 */
  private ownWrites = new Map<string, string>()
  private uuid: () => string
  private now: () => string

  constructor(readonly dir: string, private deps: NoteStoreDeps) {
    mkdirSync(dir, { recursive: true })
    this.uuid = deps.uuid ?? (() => crypto.randomUUID())
    this.now = deps.now ?? (() => new Date().toISOString())
    this.scan()
  }

  /** 重新读整个目录。几千篇笔记也只是几 MB 文本 */
  scan(): void {
    const next = new Map<string, Entry>()
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.md') || name.startsWith('.')) continue
      const e = this.load(name)
      if (!e) continue
      // 两个文件头信息里的 id 一样（比如在访达里复制了一篇）：先建的那个留着 id，
      // 另一个当成还没有 id 的新笔记，第一次保存时给它新的 id
      const other = next.get(e.id)
      if (!other) next.set(e.id, e)
      else {
        const [keep, copy] = other.born < e.born || (other.born === e.born && other.file.length <= e.file.length) ? [other, e] : [e, other]
        next.set(keep.id, keep)
        next.set(`file:${copy.file}`, { ...copy, id: `file:${copy.file}`, hasHead: false })
      }
    }
    this.entries = next
  }

  private load(file: string): Entry | null {
    const path = join(this.dir, file)
    try {
      const text = readFileSync(path, 'utf8')
      const st = statSync(path)
      const { head, body, extra } = parseNote(text)
      return {
        id: head.id ?? `file:${file}`,
        title: file.slice(0, -3),
        paperId: head.paperId,
        createdAt: head.createdAt ?? st.birthtime.toISOString(),
        updatedAt: st.mtime.toISOString(),
        excerpt: noteExcerpt(body),
        links: extractLinks(body),
        annotationRefs: extractAnnotationRefs(body),
        file,
        extra,
        body,
        hasHead: Boolean(head.id),
        born: st.birthtimeMs
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

  /** 新建。标题重名时加上 2、3… */
  create(opts: { title?: string; paperId?: string; body?: string }): NoteSummary {
    const title = this.freeTitle(safeNoteTitle(opts.title ?? ''))
    const head: NoteHead = { id: this.uuid(), paperId: opts.paperId, createdAt: this.now() }
    const file = `${title}.md`
    this.write(file, serializeNote(head, opts.body ?? ''))
    const e = this.load(file)!
    this.entries.set(e.id, e)
    return summary(e)
  }

  save(id: string, body: string): NoteSummary {
    const e = this.must(id)
    const head: NoteHead = { id: e.hasHead ? e.id : this.uuid(), paperId: e.paperId, createdAt: e.createdAt }
    this.write(e.file, serializeNote(head, body, e.extra))
    const next = this.load(e.file)!
    this.entries.delete(id)
    this.entries.set(next.id, next)
    return summary(next)
  }

  /** 改标题 = 改文件名；别的笔记里的 [[旧标题]] 一起改掉 */
  rename(id: string, wanted: string): NoteSummary {
    const e = this.must(id)
    const title = safeNoteTitle(wanted)
    if (title === e.title) return summary(e)
    const free = this.freeTitle(title)
    renameSync(join(this.dir, e.file), join(this.dir, `${free}.md`))
    const old = e.title
    const pattern = new RegExp(`\\[\\[${escapeRe(old)}(?=[\\]|#])`, 'g')
    for (const other of this.entries.values()) {
      if (other.id === id || !other.links.includes(old)) continue
      const body = other.body.replace(pattern, `[[${free}`)
      if (body !== other.body) this.save(other.id, body)
    }
    this.entries.delete(id)
    const next = this.load(`${free}.md`)!
    this.entries.set(next.id, next)
    return summary(next)
  }

  async remove(id: string): Promise<void> {
    const e = this.must(id)
    await this.deps.trash(join(this.dir, e.file))
    this.entries.delete(id)
  }

  /** 给同步用：读、写、删都按 id。写的时候不改别的笔记里的 [[链接]]（那些改动会作为别的笔记的修改同步过来） */
  syncFiles(onTrashError: (e: unknown) => void = () => {}): NoteFiles {
    return {
      all: () => {
        // 用别的编辑器新建、还没有头信息的笔记：补上 id 才能同步
        for (const e of [...this.entries.values()]) if (!e.hasHead) this.save(e.id, e.body)
        return [...this.entries.values()].map((e): NoteDoc => ({ id: e.id, title: e.title, createdAt: e.createdAt, body: e.body, ...(e.paperId ? { paperId: e.paperId } : {}) }))
      },
      put: (doc) => {
        const e = this.entries.get(doc.id)
        const head: NoteHead = { id: doc.id, paperId: doc.paperId, createdAt: doc.createdAt }
        let file = e?.file
        const wanted = safeNoteTitle(doc.title)
        if (!e || wanted !== e.title) {
          if (e) this.entries.delete(doc.id)
          const free = this.freeTitle(wanted)
          if (e) renameSync(join(this.dir, e.file), join(this.dir, `${free}.md`))
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
        this.deps.trash(join(this.dir, e.file)).catch(onTrashError)
      }
    }
  }

  /** 按标题找（[[链接]] 用），不分大小写 */
  byTitle(title: string): NoteSummary | null {
    const t = title.toLowerCase()
    for (const e of this.entries.values()) if (e.title.toLowerCase() === t) return summary(e)
    return null
  }

  /** 目录被外部改动时回调；自己写的不算 */
  watch(onChange: () => void): void {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      this.watcher = watch(this.dir, (_event, name) => {
        // 自己保存时用的临时文件
        if (name && name.startsWith('.') && name.endsWith('.tmp')) return
        if (name && this.ownWrites.has(name)) {
          const path = join(this.dir, name)
          const same = existsSync(path) && readFileSync(path, 'utf8') === this.ownWrites.get(name)
          if (same) return
        }
        clearTimeout(timer)
        timer = setTimeout(() => {
          this.scan()
          onChange()
        }, 200)
      })
    } catch {
      /* 监听不了就只在应用内的改动后刷新 */
    }
  }

  close(): void {
    this.watcher?.close()
  }

  private write(file: string, text: string): void {
    this.ownWrites.set(file, text)
    // 先写临时文件再改名：写到一半退出或断电，原来的笔记还是完整的
    const tmp = join(this.dir, `.${file}.tmp`)
    writeFileSync(tmp, text)
    renameSync(tmp, join(this.dir, file))
  }

  private freeTitle(title: string): string {
    const taken = new Set([...this.entries.values()].map((e) => e.title.toLowerCase()))
    if (!taken.has(title.toLowerCase()) && !existsSync(join(this.dir, `${title}.md`))) return title
    for (let i = 2; ; i++) {
      const t = `${title} ${i}`
      if (!taken.has(t.toLowerCase()) && !existsSync(join(this.dir, `${t}.md`))) return t
    }
  }

  private must(id: string): Entry {
    const e = this.entries.get(id)
    if (!e) throw new Error('note not found')
    return e
  }
}

function summary(e: Entry): NoteSummary {
  return { id: e.id, title: e.title, paperId: e.paperId, createdAt: e.createdAt, updatedAt: e.updatedAt, excerpt: e.excerpt, links: e.links, annotationRefs: e.annotationRefs }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
