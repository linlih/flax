// 资料库被恢复、拷贝，或者上传结果不确定时，同步不能悄悄丢改动。
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Library, LibraryTooNewError, resetDeviceIdentity } from '../library'
import { Hlc } from './hlc'
import type { PaperMeta } from '../model'
import { createLibrary, SyncEngine } from './engine'
import type { Backend } from './backend'
import { memoryBackend, nodeCodec } from './node.testutil'

const meta = (title: string): PaperMeta => ({ title, authors: [{ family: 'V' }], identifiers: {}, source: 'user' })
let clock = Date.parse('2026-11-09T10:00:00Z')
const tick = () => new Date((clock += 1000)).toISOString()
const dir = mkdtempSync(join(tmpdir(), 'flax-recovery-'))
let n = 0

function open(backend: Backend, key: Uint8Array | null, db = new DatabaseSync(join(dir, `d${n++}.sqlite`))) {
  const lib = new Library(db, { now: tick })
  const engine = new SyncEngine({ backend, codec: nodeCodec, stores: [lib.syncStore(), lib.conversationSyncStore()], state: { get: (k) => lib.metaGet(k), set: (k, v) => lib.metaSet(k, v) }, deviceId: lib.deviceId, deviceName: 'x', platform: 't', key, now: () => clock })
  return { db, lib, engine }
}
const copy = (db: DatabaseSync) => {
  const f = join(dir, `copy${n++}.sqlite`)
  db.exec(`VACUUM INTO '${f}'`)
  return new DatabaseSync(f)
}
const titles = (l: Library) => l.listPapers().map((p) => p.title).sort()

it('a library copied to a second machine (same device id) still exchanges changes', async () => {
  const backend = memoryBackend()
  const { key } = await createLibrary(backend, nodeCodec, null)
  const a = open(backend, key)
  a.lib.addPaper(meta('base'))
  await a.engine.sync()
  const b = open(backend, key, copy(a.db))
  expect(b.lib.deviceId).toBe(a.lib.deviceId)
  a.lib.addPaper(meta('from A'))
  b.lib.addPaper(meta('from B'))
  await a.engine.sync(); await b.engine.sync(); await a.engine.sync(); await b.engine.sync()
  expect(titles(a.lib)).toEqual(titles(b.lib))
})

it('after going back to an older copy of the database, later changes still reach other devices and its own lost changes come back', async () => {
  const backend = memoryBackend()
  const { key } = await createLibrary(backend, nodeCodec, null)
  const a = open(backend, key)
  const b = open(backend, key)
  a.lib.addPaper(meta('p1'))
  await a.engine.sync()
  const backup = copy(a.db)
  a.lib.addPaper(meta('p2'))
  await a.engine.sync()
  await b.engine.sync()
  const a2 = open(backend, key, backup)
  a2.lib.addPaper(meta('p3 after restore'))
  await a2.engine.sync()
  await b.engine.sync(); await a2.engine.sync(); await b.engine.sync()
  expect(titles(b.lib)).toEqual(['p1', 'p2', 'p3 after restore'])
  expect(titles(a2.lib)).toEqual(['p1', 'p2', 'p3 after restore'])
})

it('an upload that reached the server but looked failed is not rewritten under the same number', async () => {
  const mem = memoryBackend()
  const { key } = await createLibrary(mem, nodeCodec, null)
  let lie = false
  const flaky: Backend = { ...mem, list: (d) => mem.list(d), get: (p) => mem.get(p), del: (p) => mem.del(p), put: async (p, d) => { await mem.put(p, d); if (lie && p.startsWith('log/')) throw new Error('timeout') } }
  const a = open(flaky, key)
  const b = open(mem, key)
  a.lib.addPaper(meta('p1'))
  lie = true
  await a.engine.sync().catch(() => {})
  lie = false
  await b.engine.sync()
  a.lib.addPaper(meta('p2'))
  await a.engine.sync()
  await b.engine.sync(); await b.engine.sync()
  expect(titles(b.lib)).toEqual(['p1', 'p2'])
})

it('a backup opened on another machine is a new device, and newer edits elsewhere still win', async () => {
  const backend = memoryBackend()
  const { key } = await createLibrary(backend, nodeCodec, null)
  const a = open(backend, key)
  const p = a.lib.addPaper(meta('old title'))
  await a.engine.sync()
  const backup = copy(a.db)
  resetDeviceIdentity(backup)
  a.lib.updatePaper(p.id, { title: 'newer title' })
  await a.engine.sync()

  const c = open(backend, key, backup)
  expect(c.lib.deviceId).not.toBe(a.lib.deviceId)
  c.lib.addPaper(meta('added on C'))
  await c.engine.sync(); await a.engine.sync(); await c.engine.sync()
  expect(titles(a.lib)).toEqual(['added on C', 'newer title'])
  expect(titles(c.lib)).toEqual(['added on C', 'newer title'])
})

it('restoring a backup makes its content win over edits made after the backup', async () => {
  const backend = memoryBackend()
  const { key } = await createLibrary(backend, nodeCodec, null)
  const a = open(backend, key)
  const b = open(backend, key)
  const p = a.lib.addPaper(meta('as backed up'))
  const gone = a.lib.addPaper(meta('deleted later'))
  await a.engine.sync(); await b.engine.sync()
  const backup = copy(a.db)
  b.lib.updatePaper(p.id, { title: 'edited on B afterwards' })
  b.lib.removePaper(gone.id)
  b.lib.addPaper(meta('added on B afterwards'))
  await b.engine.sync(); await a.engine.sync()

  resetDeviceIdentity(backup, clock + 10_000)
  const a2 = open(backend, key, backup)
  await a2.engine.sync(); await b.engine.sync(); await a2.engine.sync()
  const want = ['added on B afterwards', 'as backed up', 'deleted later']
  expect(titles(a2.lib)).toEqual(want)
  expect(titles(b.lib)).toEqual(want)
})

it('the clock counter never grows past 4 digits, so stamps keep sorting as strings', () => {
  const h = new Hlc('dev', null, () => 1000)
  let prev = ''
  for (let i = 0; i < 25_000; i++) {
    const s = h.tick(1000)
    expect(s > prev).toBe(true)
    expect(s).toMatch(/^\d{16}-\d{4}-dev$/)
    prev = s
  }
})

it('refuses a database made by a newer version instead of opening it', () => {
  const db = new DatabaseSync(':memory:')
  new Library(db)
  db.exec('PRAGMA user_version = 999')
  expect(() => new Library(db)).toThrow(LibraryTooNewError)
})

it('trash: a deleted paper can be put back; deleting it for good frees its PDF on every device', async () => {
  const backend = memoryBackend()
  const { key } = await createLibrary(backend, nodeCodec, null)
  const a = open(backend, key)
  const b = open(backend, key)
  const file = (hash: string) => ({ file: { hash, size: 1, mime: 'application/pdf' as const, role: 'main' as const, addedAt: tick() } })
  const keep = a.lib.addPaper(meta('keep'), file('aa'.repeat(32)))
  const gone = a.lib.addPaper(meta('gone'), file('bb'.repeat(32)))
  await a.engine.sync(); await b.engine.sync()

  a.lib.removePaper(keep.id)
  a.lib.removePaper(gone.id)
  expect(a.lib.listTrash().map((p) => p.title).sort()).toEqual(['gone', 'keep'])
  // 还在废纸篓里：PDF 不动
  expect(a.lib.takeOrphanFiles()).toEqual([])
  a.lib.restorePaper(keep.id)
  a.lib.purgePaper(gone.id)
  expect(a.lib.listTrash()).toEqual([])
  expect(a.lib.takeOrphanFiles()).toEqual(['bb'.repeat(32)])
  expect(a.lib.takeOrphanFiles()).toEqual([])

  await a.engine.sync(); await b.engine.sync()
  expect(titles(b.lib)).toEqual(['keep'])
  expect(b.lib.listTrash()).toEqual([])
  expect(b.lib.takeOrphanFiles()).toEqual(['bb'.repeat(32)])
  // 没删的那篇的 PDF 一直在
  expect(b.lib.liveFileHashes()).toEqual(['aa'.repeat(32)])
})
