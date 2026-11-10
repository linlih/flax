// 同步服务：连接设置、定时同步、PDF 的上传和下载。核心的合并和日志格式在 @flax/core 的 sync 里。
//
// 什么时候同步：开启时、应用启动时、本机改了东西几秒后、每 5 分钟、窗口重新回到前台时。
// 出错后按 1、2、4…分钟退避，最长 30 分钟；坚果云免费版对请求次数有限制，不能一直重试。
// 设置存在资料文件夹的 sync/settings.json；WebDAV 密码和库密钥用系统钥匙串加密后存在 sync/secret.bin。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
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
  type HttpFetch,
  type Library,
  type SqlDb,
  type SyncStore
} from '@flax/core'
import type { SyncConnect, SyncStatus } from '../shared/api'
import type { NoteStore } from './notes'
import { sha256, type FileStore } from './store'
import { folderBackend } from './syncFolder'
import { nodeCodec } from './syncCodec'
import { deviceName } from './device'

export const JIANGUOYUN = 'https://dav.jianguoyun.com/dav/'

interface Saved {
  conn: { kind: 'webdav'; url: string; username: string; folder?: string } | { kind: 'folder'; path: string }
  encrypted: boolean
}
interface Secret {
  password?: string
  key?: string
}

export interface Crypt {
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

export interface SyncDeps {
  dataDir: string
  db: SqlDb
  library: Library
  notes: NoteStore
  files: FileStore
  crypt: Crypt
  fetch: HttpFetch
  onStatus: (s: SyncStatus) => void
  /** 合并进来了别的设备的修改 */
  onReceived: () => void
  /** 测试时改短 */
  pollMs?: number
  activePollMs?: number
}

/** 窗口不在前台时多久看一次云端。坚果云对 WebDAV 有请求频率限制（同一个账号的设备共用），没人看的时候不必问得勤 */
const POLL_MS = 5 * 60_000
/** 窗口在前台时：别的设备改的东西一分钟内就能看到。一般同一时间只有一台设备在前台，请求数不会超 */
const ACTIVE_POLL_MS = 60_000
const POKE_MS = 4000
const MAX_BACKOFF_MS = 30 * 60_000

export class SyncService {
  private dir: string
  private engine: SyncEngine | null = null
  private stores: SyncStore[]
  private saved: Saved | null = null
  private status: SyncStatus
  private timer: ReturnType<typeof setTimeout> | null = null
  /** timer 到点的时间 */
  private due = 0
  private pokeTimer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  /** 窗口在前台 */
  private active = false
  private downloads = new Map<string, Promise<boolean>>()
  private uploading = false

  constructor(private d: SyncDeps) {
    this.dir = join(d.dataDir, 'sync')
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
    this.stores = [d.library.syncStore(), d.library.conversationSyncStore(), createNoteSyncStore(d.db, d.library.deviceId, d.notes.syncFiles((e) => console.error('trash note:', e)), tx, () => crypto.randomUUID())]
    this.status = { config: null, encrypted: false, state: 'off', canEncrypt: d.crypt.available() }
    this.load()
  }

  get(): SyncStatus {
    return this.status
  }

  private set(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch }
    this.d.onStatus(this.status)
  }

  private load(): void {
    try {
      this.saved = JSON.parse(readFileSync(join(this.dir, 'settings.json'), 'utf8')) as Saved
    } catch {
      this.saved = null
      return
    }
    let secret: Secret = {}
    try {
      secret = JSON.parse(this.d.crypt.decrypt(readFileSync(join(this.dir, 'secret.bin')))) as Secret
    } catch {
      /* 没有或解不开：下面按出错处理 */
    }
    const lastSync = this.d.library.metaGet('sync.lastSync') ?? undefined
    this.status = { ...this.status, config: view(this.saved), encrypted: this.saved.encrypted, state: 'idle', ...(lastSync ? { lastSync } : {}) }
    if (this.saved.encrypted && !secret.key) {
      this.status = { ...this.status, state: 'error', error: '这台设备上的同步密码丢了，请停用同步后重新开启。' }
      return
    }
    this.engine = this.makeEngine(this.backendFor(this.saved.conn, secret.password ?? ''), secret.key ? fromBase64(secret.key) : null)
  }

  private backendFor(conn: Saved['conn'], password: string): Backend {
    if (conn.kind === 'folder') return folderBackend(conn.path)
    return webdav({ url: conn.url, username: conn.username, password, folder: conn.folder ?? 'Flax', fetch: this.d.fetch, timeout: (ms) => AbortSignal.timeout(ms) })
  }

  private makeEngine(backend: Backend, key: Uint8Array | null): SyncEngine {
    const lib = this.d.library
    return new SyncEngine({
      backend,
      codec: nodeCodec,
      stores: this.stores,
      state: { get: (k) => lib.metaGet(k), set: (k, v) => lib.metaSet(k, v) },
      deviceId: lib.deviceId,
      deviceName: deviceName(),
      platform: process.platform,
      key
    })
  }

  // —— 开启和停用 ——

  /** 先看看那里是不是已经有一个同步库（决定界面上是"设置同步密码"还是"输入同步密码"） */
  async probe(c: SyncConnect): Promise<{ exists: boolean; encrypted: boolean }> {
    try {
      const info = await readLibraryInfo(this.backendFor(conn(c), c.kind === 'webdav' ? c.password : ''))
      return { exists: !!info, encrypted: !!info?.enc }
    } catch (e) {
      throw new Error(message(e))
    }
  }

  /** 开启同步。那里已经有同步库就加入它（要输入当时的同步密码），没有就新建（syncPassword 为 null 时不加密） */
  async connect(c: SyncConnect, syncPassword: string | null): Promise<void> {
    try {
      await this.connectInner(c, syncPassword)
    } catch (e) {
      throw new Error(message(e))
    }
  }

  private async connectInner(c: SyncConnect, syncPassword: string | null): Promise<void> {
    if (!this.d.crypt.available()) throw new Error('系统钥匙串不可用，没法安全地保存同步密码。')
    const backend = this.backendFor(conn(c), c.kind === 'webdav' ? c.password : '')
    let info = await readLibraryInfo(backend)
    let key: Uint8Array | null
    if (info) key = await unlockLibrary(info, nodeCodec, info.enc ? syncPassword : null)
    else {
      const made = await createLibrary(backend, nodeCodec, syncPassword)
      info = made.info
      key = made.key
    }
    // 换了一个同步库：所有记录和 PDF 都当成没传过
    if (this.d.library.metaGet('sync.library') !== info.id) {
      SyncEngine.forget({ get: (k) => this.d.library.metaGet(k), set: (k, v) => this.d.library.metaSet(k, v) }, this.stores)
      this.d.library.forgetSyncedFiles()
    }
    const saved: Saved = { conn: conn(c), encrypted: !!info.enc }
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(join(this.dir, 'settings.json'), JSON.stringify(saved, null, 2) + '\n')
    const secret: Secret = { ...(c.kind === 'webdav' ? { password: c.password } : {}), ...(key ? { key: toBase64(key) } : {}) }
    writeFileSync(join(this.dir, 'secret.bin'), this.d.crypt.encrypt(JSON.stringify(secret)), { mode: 0o600 })
    this.saved = saved
    this.engine = this.makeEngine(backend, key)
    this.failures = 0
    this.set({ config: view(saved), encrypted: saved.encrypted, state: 'idle', error: undefined })
    void this.run()
  }

  /** 停用：这台设备不再同步，云端的数据不动 */
  disconnect(): void {
    this.stop()
    this.engine = null
    this.saved = null
    rmSync(this.dir, { recursive: true, force: true })
    this.d.library.metaSet('sync.lastSync', null)
    this.status = { config: null, encrypted: false, state: 'off', canEncrypt: this.d.crypt.available() }
    this.d.onStatus(this.status)
  }

  // —— 定时 ——

  start(): void {
    if (this.engine) this.schedule(3000)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.pokeTimer) clearTimeout(this.pokeTimer)
    this.timer = this.pokeTimer = null
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.due = Date.now() + ms
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run()
    }, ms)
  }

  /** 本机改了东西（任何一次界面请求之后都会叫）：几秒后看看有没有要传的 */
  poke(): void {
    if (!this.engine || this.pokeTimer) return
    this.pokeTimer = setTimeout(() => {
      this.pokeTimer = null
      if (this.engine && this.status.state !== 'syncing' && !this.failures && this.engine.hasLocalChanges()) void this.run()
    }, POKE_MS)
  }

  private interval(): number {
    return this.active ? (this.d.activePollMs ?? ACTIVE_POLL_MS) : (this.d.pollMs ?? POLL_MS)
  }

  /** 窗口回到前台：离上次同步超过一分钟就同步一次，不然一分钟到了再同步；之后每分钟看一次 */
  focused(): void {
    this.active = true
    if (!this.engine || this.failures || this.status.state === 'syncing') return
    const last = this.status.lastSync ? Date.parse(this.status.lastSync) : 0
    const wait = Math.max(0, this.interval() - (Date.now() - last))
    // 已经排了更早的（比如启动后 3 秒那次），就等它
    if (this.timer && this.due - Date.now() <= wait) return
    if (wait === 0) void this.run()
    else this.schedule(wait)
  }

  /** 窗口到后台了：下次同步完改回慢的间隔 */
  blurred(): void {
    this.active = false
  }

  /** 立即同步（界面上的按钮）；出错时抛出去显示 */
  async syncNow(): Promise<void> {
    this.failures = 0
    await this.run(true)
  }

  private async run(throwErrors = false): Promise<void> {
    const engine = this.engine
    if (!engine) return
    this.set({ state: 'syncing' })
    try {
      const r = await engine.sync()
      if (engine !== this.engine) return
      if (r.received) this.d.onReceived()
      this.failures = 0
      const at = new Date().toISOString()
      this.d.library.metaSet('sync.lastSync', at)
      this.set({ state: 'idle', lastSync: at, error: undefined })
      this.schedule(this.interval())
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

  /** 把本机有、云端还没有的 PDF 传上去，再把本机没有的下载下来。一个一个来，不抢带宽 */
  private async syncFiles(): Promise<void> {
    const engine = this.engine
    if (!engine || this.uploading) return
    this.uploading = true
    try {
      const done = this.d.library.syncedFiles()
      const hashes = this.d.library.liveFileHashes()
      const up = hashes.filter((h) => !done.has(h) && existsSync(this.d.files.pathFor(h)))
      const down = hashes.filter((h) => !existsSync(this.d.files.pathFor(h)))
      let left = up.length + down.length
      if (left) this.set({ files: { left } })
      for (const h of up) {
        if (engine !== this.engine) return
        await engine.putFile(h, new Uint8Array(await readFile(this.d.files.pathFor(h))))
        this.d.library.markFileSynced(h)
        this.set({ files: { left: --left } })
      }
      for (const h of down) {
        if (engine !== this.engine) return
        await this.download(h)
        this.set({ files: { left: --left } })
      }
    } catch (e) {
      console.error('sync files:', e)
      if (engine === this.engine) this.set({ state: 'error', error: message(e) })
    } finally {
      this.uploading = false
      if (engine === this.engine) this.set({ files: undefined })
    }
  }

  /** 从云端下载一个 PDF（打开论文时本机没有，就等它下载完再显示）。云端也没有返回 false */
  download(hash: string): Promise<boolean> {
    const engine = this.engine
    if (!engine) return Promise.resolve(false)
    let p = this.downloads.get(hash)
    if (!p) {
      p = (async () => {
        const data = await engine.getFile(hash)
        if (!data) return false
        // 内容和哈希对不上就不要：可能是传了一半的文件
        if (sha256(data) !== hash) throw new SyncError('format', '从云端下载的 PDF 不完整，下次同步时再试。')
        await this.d.files.put(data, hash)
        this.d.library.markFileSynced(hash)
        return true
      })().finally(() => this.downloads.delete(hash))
      this.downloads.set(hash, p)
    }
    return p
  }

  get enabled(): boolean {
    return !!this.engine
  }
}

function conn(c: SyncConnect): Saved['conn'] {
  if (c.kind === 'folder') return { kind: 'folder', path: c.path }
  const url = c.url.trim() || JIANGUOYUN
  return { kind: 'webdav', url, username: c.username.trim(), ...(c.folder?.trim() ? { folder: c.folder.trim() } : {}) }
}

function view(s: Saved): SyncStatus['config'] {
  return s.conn.kind === 'folder' ? { kind: 'folder', path: s.conn.path } : { kind: 'webdav', url: s.conn.url, username: s.conn.username, folder: s.conn.folder ?? 'Flax' }
}

function message(e: unknown): string {
  if (e instanceof WrongKeyError) return '同步密码不对。'
  if ((e as { name?: string }).name === 'TimeoutError') return '连接同步服务器超时了。'
  if (e instanceof SyncError) return e.message
  return e instanceof Error ? e.message : String(e)
}
