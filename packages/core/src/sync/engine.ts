// 同步引擎：把本机的修改写成日志传上去，把别的设备的日志拉下来合并。
//
// 云端的样子（都在同步根目录 Flax/ 下）：
//   flax.json                  库的 ID、格式版本、加密参数（不加密，里面没有内容）
//   log/<设备>/<序号>.flx       每台设备只往自己的目录里追加，两台设备永远不会写同一个文件
//   snap/<设备>-<序号>.flx      某台设备的完整状态；写好快照后，这台设备删掉自己的旧日志
//   devices/<设备>.flx          设备名、平台、最后同步时间
//   files/<前两位>/<哈希>       PDF
import { fromUtf8, open, seal, toBase64, fromBase64, utf8, WrongKeyError, type Codec } from './codec'
import { SyncError, type Backend } from './backend'
import { Hlc } from './hlc'
import type { SyncRecord } from './record'
import type { Outgoing, SyncStore } from './store'

export interface LibraryInfo {
  format: 1
  id: string
  created: string
  /** null = 不加密 */
  enc: null | { kdf: 'pbkdf2-sha256'; iterations: number; salt: string; check: string }
}

export interface SyncState {
  get(key: string): string | null
  set(key: string, value: string | null): void
}

export interface EngineOptions {
  backend: Backend
  codec: Codec
  stores: SyncStore[]
  state: SyncState
  deviceId: string
  deviceName: string
  platform: string
  /** 库密钥；不加密的库是 null */
  key: Uint8Array | null
  /** 自己写了多少段日志以后写一次快照、清掉旧日志 */
  snapshotEvery?: number
  /** 一段日志最多放多少条记录 */
  segmentSize?: number
  now?: () => number
}

export interface SyncResult {
  /** 从别的设备合并进来、本地真的变了的条数 */
  received: number
  /** 传上去的条数 */
  sent: number
}

const INFO = 'flax.json'
const CHECK = 'flax-sync-check'
const ITERATIONS = 600_000
const pad = (n: number) => String(n).padStart(10, '0')

const K = {
  library: 'sync.library',
  seq: 'sync.seq',
  snapSeq: 'sync.snapSeq',
  cursors: 'sync.cursors',
  hlc: 'sync.hlc',
  writer: 'sync.writer'
}

export async function readLibraryInfo(backend: Backend): Promise<LibraryInfo | null> {
  const b = await backend.get(INFO)
  if (!b) return null
  try {
    const v = JSON.parse(fromUtf8(b)) as LibraryInfo
    if (v.format !== 1 || typeof v.id !== 'string') throw new Error()
    return v
  } catch {
    throw new SyncError('format', '云端的 Flax 文件夹不是这个版本能读的格式。请先把 Flax 更新到最新版本。')
  }
}

/** 在云端新建一个同步库。password 为 null 时不加密 */
export async function createLibrary(backend: Backend, codec: Codec, password: string | null, now = () => new Date().toISOString()): Promise<{ info: LibraryInfo; key: Uint8Array | null }> {
  if (await readLibraryInfo(backend)) throw new SyncError('format', '那里已经有一个 Flax 同步库了。')
  const id = [...codec.random(16)].map((b) => b.toString(16).padStart(2, '0')).join('')
  let key: Uint8Array | null = null
  let enc: LibraryInfo['enc'] = null
  if (password !== null) {
    const salt = codec.random(16)
    key = await codec.deriveKey(password, salt, ITERATIONS)
    enc = { kdf: 'pbkdf2-sha256', iterations: ITERATIONS, salt: toBase64(salt), check: toBase64(await seal(codec, key, utf8(CHECK), false)) }
  }
  const info: LibraryInfo = { format: 1, id, created: now(), enc }
  await backend.put(INFO, utf8(JSON.stringify(info, null, 2)))
  return { info, key }
}

/** 用同步密码解开已有的库；密码不对抛 WrongKeyError */
export async function unlockLibrary(info: LibraryInfo, codec: Codec, password: string | null): Promise<Uint8Array | null> {
  if (!info.enc) return null
  if (password === null) throw new WrongKeyError()
  const key = await codec.deriveKey(password, fromBase64(info.enc.salt), info.enc.iterations)
  const check = await open(codec, key, fromBase64(info.enc.check))
  if (fromUtf8(check) !== CHECK) throw new WrongKeyError()
  return key
}

interface SegmentHead {
  v: 1
  dev: string
  seq: number
}

interface Snapshot {
  v: 1
  dev: string
  seq: number
  cursors: Record<string, number>
  records: SyncRecord[]
}

export class SyncEngine {
  private running: Promise<SyncResult> | null = null
  private hlc: Hlc

  constructor(private o: EngineOptions) {
    this.hlc = new Hlc(o.deviceId, o.state.get(K.hlc))
  }

  /** 同时只跑一次；正在跑的时候再叫，等那一次的结果 */
  sync(): Promise<SyncResult> {
    if (!this.running) this.running = this.run().finally(() => (this.running = null))
    return this.running
  }

  /** 本机有没有还没传上去的修改（只查本地数据库，不联网） */
  hasLocalChanges(): boolean {
    for (const s of this.o.stores) s.collect(this.hlc)
    this.o.state.set(K.hlc, this.hlc.last())
    return this.o.stores.some((s) => s.pending().length > 0)
  }

  /**
   * 这台设备在云端写日志用的名字。一般就是设备 id；发现云端有"自己"写的、但本机不记得的日志时换一个
   * （资料库从备份恢复过，或者被拷到了另一台电脑上，两边用着同一个设备 id）
   */
  private writer(): string {
    return this.o.state.get(K.writer) ?? this.o.deviceId
  }

  /** 换了同步库或者断开同步：忘掉读到哪了，所有记录下次都当成新的 */
  static forget(state: SyncState, stores: SyncStore[]): void {
    for (const k of Object.values(K)) if (k !== K.hlc && k !== K.writer) state.set(k, null)
    for (const s of stores) s.reset()
  }

  private async run(): Promise<SyncResult> {
    const { backend, state, stores } = this.o
    const info = await readLibraryInfo(backend)
    if (!info) throw new SyncError('not_found', '云端的 Flax 同步文件夹不见了。')
    const bound = state.get(K.library)
    if (bound !== info.id) {
      if (bound) SyncEngine.forget(state, stores)
      state.set(K.library, info.id)
    }
    if (!!info.enc !== !!this.o.key) throw new WrongKeyError()

    for (const s of stores) s.collect(this.hlc)
    const received = await this.pull()
    for (const s of stores) s.collect(this.hlc)
    const sent = await this.push()
    state.set(K.hlc, this.hlc.last())
    return { received, sent }
  }

  private cursors(): Record<string, number> {
    try {
      return JSON.parse(this.o.state.get(K.cursors) ?? '{}') as Record<string, number>
    } catch {
      return {}
    }
  }

  private async read<T>(path: string): Promise<T | null> {
    const b = await this.o.backend.get(path)
    if (!b) return null
    return JSON.parse(fromUtf8(await open(this.o.codec, this.o.key, b))) as T
  }

  private async write(path: string, v: unknown): Promise<void> {
    await this.o.backend.put(path, await seal(this.o.codec, this.o.key, utf8(JSON.stringify(v)), true))
  }

  private apply(recs: SyncRecord[]): number {
    let n = 0
    for (const s of this.o.stores) {
      const mine = recs.filter((r) => s.kinds.includes(r.k))
      if (mine.length) n += s.apply(mine, this.hlc)
    }
    return n
  }

  private async pull(): Promise<number> {
    const { backend, state } = this.o
    const all = ((await backend.list('log/')) ?? []).filter((n) => n.endsWith('/')).map((n) => n.slice(0, -1))
    const snaps = new Map<string, number>()
    for (const name of (await backend.list('snap/')) ?? []) {
      const m = /^(.+)-(\d+)\.flx$/.exec(name)
      if (m) snaps.set(m[1]!, Math.max(snaps.get(m[1]!) ?? 0, Number(m[2])))
    }
    for (const d of snaps.keys()) if (!all.includes(d)) all.push(d)

    // 云端有"自己"写的、序号比本机记得的还大的日志：资料库是从备份恢复的，或者被拷到了另一台电脑上。
    // 接着用原来的名字写，会盖掉那些日志，或者写出别的设备已经读过的序号，改动就丢了。
    // 换一个名字从头写，原来那个名字下的日志当成别的设备的读回来
    let me = this.writer()
    if (all.includes(me)) {
      const mine = ((await backend.list(`log/${me}/`)) ?? []).map((n) => Number(/^(\d+)\.flx$/.exec(n)?.[1] ?? 0))
      if (Math.max(0, snaps.get(me) ?? 0, ...mine) > Number(state.get(K.seq) ?? 0)) {
        me = `${this.o.deviceId}.${[...this.o.codec.random(4)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
        state.set(K.writer, me)
        state.set(K.seq, null)
        state.set(K.snapSeq, null)
        state.set(K.cursors, null)
      }
    }
    const devices = all.filter((d) => d !== me)

    let received = 0
    const cursors = this.cursors()
    const save = () => state.set(K.cursors, JSON.stringify(cursors))

    const loadSnapshot = async (dev: string): Promise<boolean> => {
      const seq = snaps.get(dev)
      if (!seq || seq <= (cursors[dev] ?? 0)) return false
      const snap = await this.read<Snapshot>(`snap/${dev}-${pad(seq)}.flx`)
      if (!snap) return false
      received += this.apply(snap.records)
      // 快照里已经包含了它当时读过的其他设备的修改
      for (const [d, s] of Object.entries(snap.cursors)) if (d !== me && s > (cursors[d] ?? 0)) cursors[d] = s
      cursors[dev] = Math.max(cursors[dev] ?? 0, snap.seq)
      save()
      return true
    }

    for (const dev of devices) {
      const seqs = ((await backend.list(`log/${dev}/`)) ?? [])
        .map((n) => /^(\d+)\.flx$/.exec(n)?.[1])
        .filter((x): x is string => !!x)
        .map(Number)
        .sort((a, b) => a - b)
      const cur = () => cursors[dev] ?? 0
      // 中间缺了几段（被那台设备清理掉了）：先读它的快照
      if (!seqs.includes(cur() + 1) && (snaps.get(dev) ?? 0) > cur()) await loadSnapshot(dev)
      for (const seq of seqs) {
        if (seq <= cur()) continue
        const lines = await this.readSegment(`log/${dev}/${pad(seq)}.flx`)
        if (!lines) {
          // 刚列出来就被清理掉了
          if (await loadSnapshot(dev)) continue
          break
        }
        received += this.apply(lines)
        cursors[dev] = seq
        save()
      }
    }
    return received
  }

  private async readSegment(path: string): Promise<SyncRecord[] | null> {
    const b = await this.o.backend.get(path)
    if (!b) return null
    const text = fromUtf8(await open(this.o.codec, this.o.key, b))
    const lines = text.split('\n').filter(Boolean)
    const head = JSON.parse(lines[0] ?? '{}') as SegmentHead
    if (head.v !== 1) throw new SyncError('format', '别的设备用的 Flax 版本更新，请先把这台的 Flax 更新到最新版本。')
    return lines.slice(1).map((l) => JSON.parse(l) as SyncRecord)
  }

  private async push(): Promise<number> {
    const { backend, state, stores } = this.o
    const me = this.writer()
    const size = this.o.segmentSize ?? 2000
    let sent = 0
    for (;;) {
      const items: { store: SyncStore; out: Outgoing }[] = []
      for (const store of stores) for (const out of store.pending()) items.push({ store, out })
      if (!items.length) break
      const batch = items.slice(0, size)
      const seq = Number(state.get(K.seq) ?? 0) + 1
      const head: SegmentHead = { v: 1, dev: me, seq }
      const body = [JSON.stringify(head), ...batch.map((x) => JSON.stringify(x.out.rec))].join('\n') + '\n'
      // 先记下序号再传：上传"失败"时文件可能其实已经到了云端、被别的设备读过，重试要用新的序号，不能改写同一个文件
      state.set(K.seq, String(seq))
      await backend.put(`log/${me}/${pad(seq)}.flx`, await seal(this.o.codec, this.o.key, utf8(body), true))
      for (const store of stores) store.sent(batch.filter((x) => x.store === store).map((x) => x.out))
      sent += batch.length
      if (items.length <= size) break
    }
    if (sent) {
      await this.write(`devices/${me}.flx`, { name: this.o.deviceName, platform: this.o.platform, seq: Number(state.get(K.seq)), at: new Date(this.o.now?.() ?? Date.now()).toISOString() })
      await this.maybeSnapshot()
    }
    return sent
  }

  /** 自己的日志多了以后：写一份完整快照，然后删掉自己的旧日志和旧快照 */
  private async maybeSnapshot(): Promise<void> {
    const { backend, state, stores } = this.o
    const deviceId = this.writer()
    const seq = Number(state.get(K.seq) ?? 0)
    const last = Number(state.get(K.snapSeq) ?? 0)
    if (seq - last < (this.o.snapshotEvery ?? 50)) return
    const snap: Snapshot = { v: 1, dev: deviceId, seq, cursors: this.cursors(), records: stores.flatMap((s) => s.snapshot()) }
    await this.write(`snap/${deviceId}-${pad(seq)}.flx`, snap)
    state.set(K.snapSeq, String(seq))
    for (const name of (await backend.list('snap/')) ?? []) {
      const m = /^(.+)-(\d+)\.flx$/.exec(name)
      if (m && m[1] === deviceId && Number(m[2]) < seq) await backend.del(`snap/${name}`)
    }
    for (const name of (await backend.list(`log/${deviceId}/`)) ?? []) {
      const n = Number(/^(\d+)\.flx$/.exec(name)?.[1] ?? NaN)
      if (n <= seq) await backend.del(`log/${deviceId}/${name}`)
    }
  }

  // —— PDF ——

  static filePath(hash: string): string {
    return `files/${hash.slice(0, 2)}/${hash}`
  }

  async putFile(hash: string, data: Uint8Array): Promise<void> {
    await this.o.backend.put(SyncEngine.filePath(hash), await seal(this.o.codec, this.o.key, data, false))
  }

  /** 永久删除的论文的 PDF：云端那份也删掉 */
  async deleteFile(hash: string): Promise<void> {
    await this.o.backend.del(SyncEngine.filePath(hash))
  }

  /** 云端没有返回 null */
  async getFile(hash: string): Promise<Uint8Array | null> {
    const b = await this.o.backend.get(SyncEngine.filePath(hash))
    return b ? open(this.o.codec, this.o.key, b) : null
  }

  /** 云端的设备列表（设置里显示） */
  async devices(): Promise<{ id: string; name: string; platform: string; at: string }[]> {
    const out: { id: string; name: string; platform: string; at: string }[] = []
    for (const name of (await this.o.backend.list('devices/')) ?? []) {
      const id = name.replace(/\.flx$/, '')
      if (id === name) continue
      const v = await this.read<{ name: string; platform: string; at: string }>(`devices/${name}`).catch(() => null)
      if (v) out.push({ id, ...v })
    }
    return out
  }
}
