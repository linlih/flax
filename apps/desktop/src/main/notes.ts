// 笔记仓库：数据目录下 notes/ 里的 .md 文件就是全部数据，没有另外的数据库。
// 用 Obsidian 之类的编辑器直接改文件也可以，这边监听目录变化后重新读。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { extractAnnotationRefs, extractLinks, noteExcerpt, parseNote, safeNoteTitle, serializeNote, type NoteHead } from '@paper/core'
import type { NoteSummary } from '../shared/api'

interface Entry extends NoteSummary {
  file: string
  extra: string[]
  body: string
  /** 文件里原本有没有头信息；没有的话第一次保存时补上 */
  hasHead: boolean
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
      if (e && !next.has(e.id)) next.set(e.id, e)
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
    writeFileSync(join(this.dir, file), text)
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
