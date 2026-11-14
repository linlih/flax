// SyncService：开启、加入、设置的保存、PDF 上传下载、什么时候同步、出错退避、停用。
// 后端用本地文件夹（不联网），退避用的是本地起的 WebDAV 服务器，可以随时让它"断网"。
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Library, seal, type HttpFetch, type PaperMeta } from '@flax/core'
import { nodeCodec, webdavServer } from '../../../../packages/core/src/sync/node.testutil'
import type { SyncStatus } from '../shared/api'
import { NoteStore } from './notes'
import { FileStore, sha256 } from './store'
import { SyncService, type Crypt, type SyncDeps } from './sync'

const meta = (title: string): PaperMeta => ({ title, authors: [{ family: 'Vaswani' }], identifiers: {}, source: 'user' })
const PDF = new Uint8Array(Buffer.from('%PDF-1.7 test file'))

let root: string
let cloud: string
let folder: { kind: 'folder'; path: string }
const services: SyncService[] = []
const open: DatabaseSync[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flax-sync-'))
  cloud = join(root, 'cloud')
  folder = { kind: 'folder', path: cloud }
})
afterEach(() => {
  for (const s of services.splice(0)) s.stop()
  vi.useRealTimers()
  for (const db of open.splice(0)) db.close()
  rmSync(root, { recursive: true, force: true })
})

// 钥匙串的替身：可逆，但存下来的不是明文
const keychain = (available = true): Crypt => ({
  available: () => available,
  encrypt: (t) => Buffer.from(t).reverse(),
  decrypt: (b) => Buffer.from(b).reverse().toString()
})

const realFetch: HttpFetch = (u, i) => fetch(u, i as RequestInit)

function device(name: string, extra: Partial<SyncDeps> = {}) {
  const dataDir = join(root, name)
  const db = new DatabaseSync(join(mkdirp(dataDir), 'library.sqlite'))
  open.push(db)
  const library = new Library(db)
  const notes = new NoteStore(join(dataDir, 'notes'), { trash: async (p) => rmSync(p) })
  const files = new FileStore(dataDir)
  const statuses: SyncStatus[] = []
  const d = { received: 0 }
  const deps: SyncDeps = {
    dataDir,
    db,
    library,
    notes,
    files,
    crypt: keychain(),
    fetch: realFetch,
    onStatus: (s) => statuses.push(s),
    onReceived: () => d.received++,
    pollMs: 60_000,
    ...extra
  }
  const make = () => {
    const s = new SyncService(deps)
    services.push(s)
    return s
  }
  return Object.assign(d, { dataDir, db, library, notes, files, statuses, deps, svc: make(), reopen: make })
}

function mkdirp(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

const syncs = (statuses: SyncStatus[]) => statuses.filter((s) => s.state === 'syncing').length
/** 等后台的同步（和之后的 PDF 传输）做完：用真的计时器轮询，假计时器下也能用 */
const settled = (svc: SyncService) => vi.waitFor(() => {
  const s = svc.get()
  if (s.state === 'syncing' || s.files) throw new Error('busy')
}, { timeout: 5000, interval: 5 })

describe('turning sync on', () => {
  it('creates an encrypted library, and a second device joins it with the same sync password', async () => {
    const a = device('a')
    a.library.addPaper(meta('Attention'))
    await a.svc.connect(folder, 'correct horse')
    await settled(a.svc)
    expect(a.svc.get()).toMatchObject({ state: 'idle', encrypted: true, config: { kind: 'folder', path: cloud } })
    expect(a.svc.get().lastSync).toBeTruthy()
    // 云端只有密文
    const logs = readdirSync(join(cloud, 'Flax', 'log'), { recursive: true }).filter((f) => String(f).endsWith('.flx'))
    expect(logs.length).toBeGreaterThan(0)
    for (const f of logs) expect(readFileSync(join(cloud, 'Flax', 'log', String(f))).toString('latin1')).not.toContain('Attention')

    const b = device('b')
    expect(await b.svc.probe(folder)).toEqual({ exists: true, encrypted: true })
    await expect(b.svc.connect(folder, 'wrong')).rejects.toThrow('同步密码不对。')
    expect(b.svc.get().state).toBe('off')
    await b.svc.connect(folder, 'correct horse')
    await settled(b.svc)
    expect(b.library.listPapers().map((p) => p.title)).toEqual(['Attention'])
    expect(b.received).toBe(1)
  })

  it('says when there is nothing there yet', async () => {
    expect(await device('a').svc.probe(folder)).toEqual({ exists: false, encrypted: false })
  })

  it('refuses to turn on when the keychain is not available', async () => {
    const a = device('a', { crypt: keychain(false) })
    expect(a.svc.get().canEncrypt).toBe(false)
    await expect(a.svc.connect(folder, 'correct horse')).rejects.toThrow('钥匙串不可用')
    expect(existsSync(join(cloud, 'Flax'))).toBe(false)
  })

  it('keeps the connection after a restart, with the passwords only in the encrypted secret file', async () => {
    const srv = await webdavServer('me@example.com', 'app-pass-123')
    try {
      const a = device('a')
      await a.svc.connect({ kind: 'webdav', url: srv.url, username: ' me@example.com ', password: 'app-pass-123' }, 'correct horse')
      await settled(a.svc)
      const settings = readFileSync(join(a.dataDir, 'sync', 'settings.json'), 'utf8')
      expect(JSON.parse(settings)).toEqual({ conn: { kind: 'webdav', url: srv.url, username: 'me@example.com' }, encrypted: true })
      const secret = readFileSync(join(a.dataDir, 'sync', 'secret.bin'))
      expect(secret.toString()).not.toContain('app-pass-123')
      expect(a.deps.crypt.decrypt(secret)).toContain('app-pass-123')
      // 同步密码本身不存，只存派生出来的库密钥
      expect(a.deps.crypt.decrypt(secret)).not.toContain('correct horse')

      a.library.addPaper(meta('After restart'))
      const again = a.reopen()
      expect(again.get()).toMatchObject({ state: 'idle', encrypted: true, config: { kind: 'webdav', username: 'me@example.com', folder: 'Flax' } })
      expect(again.get().lastSync).toBe(a.svc.get().lastSync)
      await again.syncNow()
      const b = device('b')
      await b.svc.connect({ kind: 'webdav', url: srv.url, username: 'me@example.com', password: 'app-pass-123' }, 'correct horse')
      await settled(b.svc)
      expect(b.library.listPapers().map((p) => p.title)).toEqual(['After restart'])
    } finally {
      await srv.close()
    }
  })

  it('asks to turn sync on again when the key on this device is gone', async () => {
    const a = device('a')
    await a.svc.connect(folder, 'correct horse')
    await settled(a.svc)
    rmSync(join(a.dataDir, 'sync', 'secret.bin'))
    const again = a.reopen()
    expect(again.get()).toMatchObject({ state: 'error', error: expect.stringContaining('同步密码丢了') })
    expect(again.enabled).toBe(false)
  })
})

describe('PDFs', () => {
  it('uploads PDFs after a sync and the other device downloads them, checking the hash', async () => {
    const a = device('a')
    const hash = await a.files.put(PDF)
    a.library.addPaper(meta('With PDF'), { file: { hash, size: PDF.length, mime: 'application/pdf', role: 'main', addedAt: '2026-11-09T00:00:00.000Z' } })
    await a.svc.connect(folder, null)
    await settled(a.svc)
    expect(existsSync(join(cloud, 'Flax', 'files', hash.slice(0, 2), hash))).toBe(true)
    expect(a.library.syncedFiles().has(hash)).toBe(true)

    const b = device('b')
    await b.svc.connect(folder, null)
    await settled(b.svc)
    expect(readFileSync(b.files.pathFor(hash))).toEqual(Buffer.from(PDF))
    expect(b.statuses.some((s) => s.files?.left === 1)).toBe(true)
  })

  it('downloads a PDF on demand once, and refuses one that does not match its hash', async () => {
    const a = device('a')
    await a.svc.connect(folder, null)
    await settled(a.svc)
    expect(await a.svc.download('ab'.repeat(32))).toBe(false)

    const good = sha256(PDF)
    // 没加密的库：云端的文件就是没加密的封装
    const sealed = await seal(nodeCodec, null, PDF, false)
    writeFileSync(join(mkdirp(join(cloud, 'Flax', 'files', good.slice(0, 2))), good), sealed)
    const [one, two] = [a.svc.download(good), a.svc.download(good)]
    expect(one).toBe(two)
    expect(await one).toBe(true)
    expect(existsSync(a.files.pathFor(good))).toBe(true)

    const bad = 'cd'.repeat(32)
    writeFileSync(join(mkdirp(join(cloud, 'Flax', 'files', 'cd')), bad), sealed)
    await expect(a.svc.download(bad)).rejects.toThrow('不完整')
    expect(existsSync(a.files.pathFor(bad))).toBe(false)
  })
})

describe('a PDF that will not upload', () => {
  it('is skipped so the others still go up, and is not sent again on every sync', async () => {
    const srv = await webdavServer('me@example.com', 'app-pass-123')
    const PDF2 = new Uint8Array([...PDF, 10, 37, 37, 69, 79, 70])
    const bad = sha256(PDF2)
    let tries = 0
    const picky: HttpFetch = (u, i) => {
      if (i.method === 'PUT' && u.endsWith(bad)) {
        tries++
        return Promise.resolve({ status: 500, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) })
      }
      return realFetch(u, i)
    }
    try {
      const a = device('a', { fetch: picky })
      const good = await a.files.put(PDF)
      await a.files.put(PDF2)
      const ref = (hash: string, size: number) => ({ file: { hash, size, mime: 'application/pdf' as const, role: 'main' as const, addedAt: '2026-11-09T00:00:00.000Z' } })
      a.library.addPaper(meta('Fine'), ref(good, PDF.length))
      a.library.addPaper(meta('Too much for the server'), ref(bad, PDF2.length))
      await a.svc.connect({ kind: 'webdav', url: srv.url, username: 'me@example.com', password: 'app-pass-123' }, null)
      await settled(a.svc)
      expect(a.library.syncedFiles().has(good)).toBe(true)
      expect(a.library.syncedFiles().has(bad)).toBe(false)
      expect(a.svc.get().error).toContain('有 PDF 没传完')
      expect(tries).toBe(1)

      await a.svc.syncNow()
      await settled(a.svc)
      expect(tries).toBe(1)
    } finally {
      await srv.close()
    }
  })
})

describe('when it syncs', () => {
  it('syncs 3 seconds after start, then on the poll interval', async () => {
    const a = device('a')
    await a.svc.connect(folder, null)
    await settled(a.svc)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const s = a.reopen()
    a.statuses.length = 0
    s.start()
    await vi.advanceTimersByTimeAsync(2900)
    expect(syncs(a.statuses)).toBe(0)
    await vi.advanceTimersByTimeAsync(100)
    await settled(s)
    expect(syncs(a.statuses)).toBe(1)
    await vi.advanceTimersByTimeAsync(59_000)
    expect(syncs(a.statuses)).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    await settled(s)
    expect(syncs(a.statuses)).toBe(2)
    s.stop()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(syncs(a.statuses)).toBe(2)
  })

  it('a poke only syncs when this device changed something, 4 seconds later, once', async () => {
    const a = device('a')
    await a.svc.connect(folder, null)
    await settled(a.svc)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    a.statuses.length = 0
    a.svc.poke()
    await vi.advanceTimersByTimeAsync(5000)
    expect(syncs(a.statuses)).toBe(0)

    a.library.addPaper(meta('New'))
    a.svc.poke()
    await vi.advanceTimersByTimeAsync(2000)
    a.svc.poke()
    await vi.advanceTimersByTimeAsync(2000)
    await settled(a.svc)
    expect(syncs(a.statuses)).toBe(1)
    expect(a.svc.get().state).toBe('idle')
    a.svc.stop()
  })

  it('syncs when the window comes back only if the last sync was over a minute ago', async () => {
    const a = device('a', { pollMs: undefined })
    await a.svc.connect(folder, null)
    await settled(a.svc)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: Date.now() })
    a.svc.stop()
    a.statuses.length = 0
    // 刚同步过：回到前台不马上同步，一分钟到了才同步
    a.svc.focused()
    expect(syncs(a.statuses)).toBe(0)
    await vi.advanceTimersByTimeAsync(59_000)
    expect(syncs(a.statuses)).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    await settled(a.svc)
    expect(syncs(a.statuses)).toBe(1)
    // 到后台待了一分多钟（后台五分钟才看一次），回来马上同步
    a.svc.blurred()
    await vi.advanceTimersByTimeAsync(60_000)
    await settled(a.svc)
    expect(syncs(a.statuses)).toBe(2)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(syncs(a.statuses)).toBe(2)
    a.svc.focused()
    await settled(a.svc)
    expect(syncs(a.statuses)).toBe(3)
    a.svc.stop()
  })

  it('checks every minute while the window is in front and every 5 minutes behind it', async () => {
    const a = device('a', { pollMs: undefined })
    await a.svc.connect(folder, null)
    await settled(a.svc)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const s = a.reopen()
    a.statuses.length = 0
    // 启动时窗口正好到前台：还是等启动后 3 秒那次
    s.start()
    s.focused()
    await vi.advanceTimersByTimeAsync(2900)
    expect(syncs(a.statuses)).toBe(0)
    await vi.advanceTimersByTimeAsync(100)
    await settled(s)
    expect(syncs(a.statuses)).toBe(1)
    for (let i = 2; i <= 4; i++) {
      await vi.advanceTimersByTimeAsync(60_000)
      await settled(s)
      expect(syncs(a.statuses)).toBe(i)
    }
    // 到后台：已经排好的那一次照常，之后五分钟一次
    s.blurred()
    await vi.advanceTimersByTimeAsync(60_000)
    await settled(s)
    expect(syncs(a.statuses)).toBe(5)
    await vi.advanceTimersByTimeAsync(4 * 60_000 + 59_000)
    expect(syncs(a.statuses)).toBe(5)
    await vi.advanceTimersByTimeAsync(1000)
    await settled(s)
    expect(syncs(a.statuses)).toBe(6)
    s.stop()
  })
})

describe('errors', () => {
  it('backs off 1, 2, 4… minutes up to 30, then recovers; pokes and focus wait', async () => {
    const srv = await webdavServer('me@example.com', 'app-pass-123')
    let down = false
    const flaky: HttpFetch = (u, i) => (down ? Promise.reject(new TypeError('fetch failed')) : realFetch(u, i))
    try {
      const a = device('a', { fetch: flaky })
      await a.svc.connect({ kind: 'webdav', url: srv.url, username: 'me@example.com', password: 'app-pass-123' }, null)
      await settled(a.svc)
      a.svc.stop()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      down = true
      a.statuses.length = 0
      await expect(a.svc.syncNow()).rejects.toThrow('fetch failed')
      expect(a.svc.get()).toMatchObject({ state: 'error', error: '连不上同步服务器，请检查网络和服务器地址（fetch failed）' })

      // 出错期间本机改了东西、窗口回到前台，都不去重试
      a.library.addPaper(meta('Offline'))
      a.svc.poke()
      a.svc.focused()
      await vi.advanceTimersByTimeAsync(5000)
      expect(syncs(a.statuses)).toBe(1)

      const gaps = [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000]
      for (const [i, gap] of gaps.entries()) {
        // 每轮开始时离上次失败已经过了 5 秒
        await vi.advanceTimersByTimeAsync(gap - 6000)
        expect(syncs(a.statuses)).toBe(i + 1)
        await vi.advanceTimersByTimeAsync(6000)
        await settled(a.svc)
        expect(syncs(a.statuses)).toBe(i + 2)
        a.svc.poke()
        a.svc.focused()
      }

      // "立即同步"：出错时抛出原因；恢复后清掉错误
      await expect(a.svc.syncNow()).rejects.toThrow('fetch failed')
      // fetch 自己也用计时器，真的发请求前换回真计时器
      a.svc.stop()
      vi.useRealTimers()
      down = false
      await a.svc.syncNow()
      await settled(a.svc)
      expect(a.svc.get()).toMatchObject({ state: 'idle', error: undefined })
      a.svc.stop()
    } finally {
      await srv.close()
    }
  })
})

describe('turning sync off', () => {
  it('forgets the settings on this device and leaves the cloud alone', async () => {
    const a = device('a')
    a.library.addPaper(meta('Kept'))
    await a.svc.connect(folder, 'correct horse')
    await settled(a.svc)
    a.svc.disconnect()
    expect(a.svc.get()).toEqual({ config: null, encrypted: false, state: 'off', canEncrypt: true })
    expect(a.svc.enabled).toBe(false)
    expect(existsSync(join(a.dataDir, 'sync'))).toBe(false)
    expect(a.library.metaGet('sync.lastSync')).toBeNull()
    expect(existsSync(join(cloud, 'Flax', 'flax.json'))).toBe(true)
    expect(a.reopen().get().state).toBe('off')
    expect(a.library.listPapers()).toHaveLength(1)
  })

  it('sends everything again when pointed at a different cloud library', async () => {
    const a = device('a')
    const hash = await a.files.put(PDF)
    a.library.addPaper(meta('Moved'), { file: { hash, size: PDF.length, mime: 'application/pdf', role: 'main', addedAt: '2026-11-09T00:00:00.000Z' } })
    await a.svc.connect(folder, null)
    await settled(a.svc)
    a.svc.disconnect()

    const other = join(root, 'other-cloud')
    await a.svc.connect({ kind: 'folder', path: other }, null)
    await settled(a.svc)
    expect(existsSync(join(other, 'Flax', 'files', hash.slice(0, 2), hash))).toBe(true)
    const b = device('b')
    await b.svc.connect({ kind: 'folder', path: other }, null)
    await settled(b.svc)
    expect(b.library.listPapers().map((p) => p.title)).toEqual(['Moved'])
  })
})
