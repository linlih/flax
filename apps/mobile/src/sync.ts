// 同步服务（手机版），规则和桌面 apps/desktop/src/main/sync.ts 一样：
// 开启时、启动时、本机改了东西几秒后、每 5 分钟、回到前台时同步；出错后按 1、2、4…分钟退避，最长 30 分钟。
// 设置存在 sync/settings.json；WebDAV 密码和库密钥存在 SecureStore（Android Keystore）。
// 手机上只支持 WebDAV（没有"本地文件夹"这种后端）。
import { File } from 'expo-file-system'
import {
  createLibrary,
  createNoteSyncStore,
  fromBase64,
  readLibraryInfo,
  SyncEngine,
  SyncError,
  toBase64,
  unlockLibrary,
  webdav,
  WrongKeyError,
  type Backend,
  type Library,
  type SqlDb,
  type SyncStore
} from '@flax/core'
import { rnCodec } from './platform/codec'
import { hasPdf, putPdf, readPdf } from './platform/files'
import { sha256 } from './platform/hash'
import { httpFetch } from './platform/net'
import { syncDir } from './platform/paths'
import { secrets } from './platform/secrets'
import type { NoteStore } from './platform/notes'

export const JIANGUOYUN = 'https://dav.jianguoyun.com/dav/'

export interface SyncConnect {
  url: string
  username: string
  password: string
  folder?: string
}

export interface SyncStatus {
  config: { url: string; username: string; folder: string } | null
  encrypted: boolean
  state: 'off' | 'idle' | 'syncing' | 'error'
  lastSync?: string
  error?: string
  files?: { left: number }
}

interface Saved {
  conn: { kind: 'webdav'; url: string; username: string; folder?: string }
  encrypted: boolean
}
interface Secret {
  password?: string
  key?: string
}

export interface SyncDeps {
  db: SqlDb
  library: Library
  notes: NoteStore
  deviceName: string
  onStatus: (s: SyncStatus) => void
  onReceived: () => void
}

const POLL_MS = 5 * 60_000
const POKE_MS = 4000
const MAX_BACKOFF_MS = 30 * 60_000
const SECRET = 'sync.secret'

const settingsFile = () => new File(syncDir, 'settings.json')

export class SyncService {
  private engine: SyncEngine | null = null
  private stores: SyncStore[]
  private saved: Saved | null = null
  private status: SyncStatus = { config: null, encrypted: false, state: 'off' }
  private timer: ReturnType<typeof setTimeout> | null = null
  private pokeTimer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  private downloads = new Map<string, Promise<boolean>>()
  /** 传不上去的 PDF：哈希 → 失败了几次、什么时候再试。免得一个大文件每次同步都重传一遍 */
  private fileRetry = new Map<string, { fails: number; at: number }>()
  private moving = false
  /** 这次同步有没有改到笔记文件（冲突副本这种不算"收到"，但界面也要刷新） */
  private notesTouched = false

  constructor(private d: SyncDeps) {
    const tx = <T>(fn: () => T): T => {
      d.db.exec('BEGIN')
      try {
        const r = fn()
        d.db.exec('COMMIT')
        return r
      } catch (e) {
        d.db.exec('ROLLBACK')
        throw e
      }
    }
    const files = d.notes.syncFiles()
    const watched: typeof files = {
      all: () => files.all(),
      put: (doc) => {
        this.notesTouched = true
        files.put(doc)
      },
      remove: (id) => {
        this.notesTouched = true
        files.remove(id)
      }
    }
    this.stores = [d.library.syncStore(), d.library.conversationSyncStore(), createNoteSyncStore(d.db, d.library.deviceId, watched, tx, () => crypto.randomUUID())]
    this.load()
  }

  get(): SyncStatus {
    return this.status
  }

  get enabled(): boolean {
    return !!this.engine
  }

  private set(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch }
    this.d.onStatus(this.status)
  }

  private load(): void {
    const f = settingsFile()
    if (!f.exists) return
    try {
      this.saved = JSON.parse(f.textSync()) as Saved
    } catch {
      this.saved = null
      return
    }
    let secret: Secret = {}
    try {
      secret = JSON.parse(secrets.get(SECRET) ?? '{}') as Secret
    } catch {
      /* 下面按出错处理 */
    }
    const lastSync = this.d.library.metaGet('sync.lastSync') ?? undefined
    this.status = { config: view(this.saved), encrypted: this.saved.encrypted, state: 'idle', ...(lastSync ? { lastSync } : {}) }
    if (this.saved.encrypted && !secret.key) {
      this.status = { ...this.status, state: 'error', error: '这台设备上的同步密码丢了，请停用同步后重新开启。' }
      return
    }
    this.engine = this.makeEngine(this.backendFor(this.saved.conn, secret.password ?? ''), secret.key ? fromBase64(secret.key) : null)
  }

  private backendFor(conn: Saved['conn'], password: string): Backend {
    return webdav({ url: conn.url, username: conn.username, password, folder: conn.folder ?? 'Flax', fetch: httpFetch, timeout: (ms) => AbortSignal.timeout(ms) })
  }

  private makeEngine(backend: Backend, key: Uint8Array | null): SyncEngine {
    const lib = this.d.library
    return new SyncEngine({
      backend,
      codec: rnCodec,
      stores: this.stores,
      state: { get: (k) => lib.metaGet(k), set: (k, v) => lib.metaSet(k, v) },
      deviceId: lib.deviceId,
      deviceName: this.d.deviceName,
      platform: 'android',
      key
    })
  }

  // —— 开启和停用 ——

  async probe(c: SyncConnect): Promise<{ exists: boolean; encrypted: boolean }> {
    try {
      const info = await readLibraryInfo(this.backendFor(conn(c), c.password))
      return { exists: !!info, encrypted: !!info?.enc }
    } catch (e) {
      throw new Error(message(e))
    }
  }

  async connect(c: SyncConnect, syncPassword: string | null): Promise<void> {
    try {
      await this.connectInner(c, syncPassword)
    } catch (e) {
      throw new Error(message(e))
    }
  }

  private async connectInner(c: SyncConnect, syncPassword: string | null): Promise<void> {
    const backend = this.backendFor(conn(c), c.password)
    let info = await readLibraryInfo(backend)
    let key: Uint8Array | null
    if (info) key = await unlockLibrary(info, rnCodec, info.enc ? syncPassword : null)
    else {
      const made = await createLibrary(backend, rnCodec, syncPassword)
      info = made.info
      key = made.key
    }
    if (this.d.library.metaGet('sync.library') !== info.id) {
      SyncEngine.forget({ get: (k) => this.d.library.metaGet(k), set: (k, v) => this.d.library.metaSet(k, v) }, this.stores)
      this.d.library.forgetSyncedFiles()
    }
    const saved: Saved = { conn: conn(c), encrypted: !!info.enc }
    if (!syncDir.exists) syncDir.create({ intermediates: true, idempotent: true })
    const f = settingsFile()
    if (!f.exists) f.create()
    f.writeSync(JSON.stringify(saved, null, 2) + '\n')
    const secret: Secret = { password: c.password, ...(key ? { key: toBase64(key) } : {}) }
    secrets.set(SECRET, JSON.stringify(secret))
    this.saved = saved
    this.engine = this.makeEngine(backend, key)
    this.failures = 0
    this.set({ config: view(saved), encrypted: saved.encrypted, state: 'idle', error: undefined })
    void this.run()
  }

  async disconnect(): Promise<void> {
    this.stop()
    this.engine = null
    this.saved = null
    const f = settingsFile()
    if (f.exists) f.delete()
    await secrets.remove(SECRET)
    this.d.library.metaSet('sync.lastSync', null)
    this.status = { config: null, encrypted: false, state: 'off' }
    this.d.onStatus(this.status)
  }

  // —— 定时 ——

  start(): void {
    if (this.engine) this.schedule(2000)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.pokeTimer) clearTimeout(this.pokeTimer)
    this.timer = this.pokeTimer = null
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.run(), ms)
  }

  /** 本机改了东西：几秒后看看有没有要传的 */
  poke(): void {
    if (!this.engine || this.pokeTimer) return
    this.pokeTimer = setTimeout(() => {
      this.pokeTimer = null
      if (this.engine && this.status.state !== 'syncing' && !this.failures && this.engine.hasLocalChanges()) void this.run()
    }, POKE_MS)
  }

  /** 回到前台：离上次同步超过一分钟就同步一次 */
  focused(): void {
    if (!this.engine || this.failures) return
    const last = this.status.lastSync ? Date.parse(this.status.lastSync) : 0
    if (Date.now() - last > 60_000) void this.run()
  }

  async syncNow(): Promise<void> {
    this.failures = 0
    await this.run(true)
  }

  private async run(throwErrors = false): Promise<void> {
    const engine = this.engine
    if (!engine) return
    this.set({ state: 'syncing' })
    this.notesTouched = false
    try {
      const r = await engine.sync()
      if (engine !== this.engine) return
      if (r.received || this.notesTouched) this.d.onReceived()
      this.failures = 0
      const at = new Date().toISOString()
      this.d.library.metaSet('sync.lastSync', at)
      this.set({ state: 'idle', lastSync: at, error: undefined })
      this.schedule(POLL_MS)
      void this.syncFiles()
    } catch (e) {
      if (engine !== this.engine) return
      this.failures++
      this.set({ state: 'error', error: message(e) })
      this.schedule(Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** (this.failures - 1)))
      if (throwErrors) throw new Error(message(e))
    }
  }

  // —— PDF ——
  // 手机空间小：本机加的 PDF 传上去；别的设备加的 PDF 不自动下载，打开时才下载（download）。

  private async syncFiles(): Promise<void> {
    const engine = this.engine
    if (!engine || this.moving) return
    this.moving = true
    try {
      const done = this.d.library.syncedFiles()
      const due = (h: string) => (this.fileRetry.get(h)?.at ?? 0) <= Date.now()
      const up = this.d.library.liveFileHashes().filter((h) => !done.has(h) && hasPdf(h) && due(h))
      let left = up.length
      if (left) this.set({ files: { left } })
      let problem: unknown = null
      for (const h of up) {
        if (engine !== this.engine) return
        try {
          await engine.putFile(h, await readPdf(h))
          this.d.library.markFileSynced(h)
          this.fileRetry.delete(h)
        } catch (e) {
          // 账号、空间、限流、断网这些换一个文件也一样：整批停下。只是这一个文件的问题（太大超时、服务器不收）就跳过它，隔一阵再试
          if (e instanceof SyncError && ['auth', 'space', 'rate_limited', 'network'].includes(e.code)) throw e
          const fails = (this.fileRetry.get(h)?.fails ?? 0) + 1
          this.fileRetry.set(h, { fails, at: Date.now() + Math.min(6 * 3600_000, 5 * 60_000 * 4 ** (fails - 1)) })
          console.warn('sync file', h, e)
          problem = e
        }
        this.set({ files: { left: --left } })
      }
      if (problem && engine === this.engine) this.set({ state: 'error', error: `有 PDF 没传完，过一阵会再试（${message(problem)}）` })
    } catch (e) {
      console.warn('sync files:', e)
      if (engine === this.engine) this.set({ state: 'error', error: message(e) })
    } finally {
      this.moving = false
      if (engine === this.engine) this.set({ files: undefined })
    }
  }

  /** 永久删除的论文的 PDF：云端那份也删掉。删不掉不算错（下次清理不会再碰它，只是云端多占一点空间） */
  async deleteRemoteFile(hash: string): Promise<void> {
    await this.engine?.deleteFile(hash).catch((e: unknown) => console.warn('delete remote file:', e))
  }

  /** 从云端下载一个 PDF。云端也没有返回 false */
  download(hash: string): Promise<boolean> {
    const engine = this.engine
    if (!engine) return Promise.resolve(false)
    let p = this.downloads.get(hash)
    if (!p) {
      p = (async () => {
        const data = await engine.getFile(hash)
        if (!data) return false
        if (sha256(data) !== hash) throw new SyncError('format', '从云端下载的 PDF 不完整，下次同步时再试。')
        await putPdf(data, hash)
        this.d.library.markFileSynced(hash)
        return true
      })().finally(() => this.downloads.delete(hash))
      this.downloads.set(hash, p)
    }
    return p
  }
}

function conn(c: SyncConnect): Saved['conn'] {
  const url = c.url.trim() || JIANGUOYUN
  return { kind: 'webdav', url, username: c.username.trim(), ...(c.folder?.trim() ? { folder: c.folder.trim() } : {}) }
}

function view(s: Saved): SyncStatus['config'] {
  return { url: s.conn.url, username: s.conn.username, folder: s.conn.folder ?? 'Flax' }
}

export function message(e: unknown): string {
  if (e instanceof WrongKeyError) return '同步密码不对。'
  if ((e as { name?: string }).name === 'TimeoutError' || (e as { name?: string }).name === 'AbortError') return '连接同步服务器超时了。'
  if (e instanceof SyncError) return e.message
  return e instanceof Error ? e.message : String(e)
}
