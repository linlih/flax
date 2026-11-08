import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { Library } from '../library'
import type { PaperMeta } from '../model'
import { parseMultistatus, SyncError, webdav } from './backend'
import { WrongKeyError } from './codec'
import { merge3 } from './diff3'
import { createLibrary, readLibraryInfo, SyncEngine, unlockLibrary } from './engine'
import { Hlc } from './hlc'
import { createNoteSyncStore, type NoteDoc, type NoteFiles } from './noteStore'
import { mergeRecord, stampChanges } from './record'
import { memoryBackend, nodeCodec, webdavServer } from './node.testutil'

const meta = (title: string, extra: Partial<PaperMeta> = {}): PaperMeta => ({ title, authors: [{ family: 'Vaswani' }], identifiers: {}, source: 'user', ...extra })

function memNotes(): NoteFiles & { docs: Map<string, NoteDoc> } {
  const docs = new Map<string, NoteDoc>()
  return {
    docs,
    all: () => [...docs.values()].map((d) => ({ ...d })),
    put: (d) => void docs.set(d.id, { ...d }),
    remove: (id) => void docs.delete(id)
  }
}

let clock = Date.parse('2026-11-09T10:00:00Z')
const tick = () => new Date((clock += 1000)).toISOString()

function device(backend: ReturnType<typeof memoryBackend>, key: Uint8Array | null, name: string) {
  const db = new DatabaseSync(':memory:')
  const lib = new Library(db, { now: tick })
  const notes = memNotes()
  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN')
    try {
      const r = fn()
      db.exec('COMMIT')
      return r
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  const noteStore = createNoteSyncStore(db, lib.deviceId, notes, tx, () => crypto.randomUUID())
  const engine = new SyncEngine({
    backend,
    codec: nodeCodec,
    stores: [lib.syncStore(), noteStore],
    state: { get: (k) => lib.metaGet(k), set: (k, v) => lib.metaSet(k, v) },
    deviceId: lib.deviceId,
    deviceName: name,
    platform: 'test',
    key,
    snapshotEvery: 5,
    now: () => clock
  })
  return { db, lib, notes, engine }
}

async function pair(password: string | null = 'correct horse') {
  const backend = memoryBackend()
  const { key } = await createLibrary(backend, nodeCodec, password)
  return { backend, a: device(backend, key, 'Mac'), b: device(backend, key, 'iPad') }
}

describe('hlc', () => {
  it('orders stamps as strings and never goes backwards after seeing a later stamp', () => {
    const h = new Hlc('dev-a', null, () => 1000)
    const s1 = h.tick()
    const s2 = h.tick()
    expect(s2 > s1).toBe(true)
    h.observe(new Hlc('dev-b', null, () => 999_999).tick())
    expect(h.tick() > '0000000000999999').toBe(true)
  })
})

describe('record merge', () => {
  it('keeps both sides when different fields change, and the later edit of the same field', () => {
    let t = 0
    const at = (dev: string) => () => `${String(++t).padStart(16, '0')}-0000-${dev}`
    const base = stampChanges('paper', null, { id: 'p', title: 'A', readingStatus: 'inbox', tags: [] }, false, at('x'))!
    const left = stampChanges('paper', base, { ...base.d, title: 'A (revised)' }, false, at('a'))!
    const right = stampChanges('paper', base, { ...base.d, readingStatus: 'done' }, false, at('b'))!
    const m1 = mergeRecord(left, right)!
    const m2 = mergeRecord(right, left)!
    expect(m1.d).toEqual({ id: 'p', title: 'A (revised)', readingStatus: 'done', tags: [], folderIds: [] })
    expect(m2.d).toEqual(m1.d)
    expect(mergeRecord(m1, right)).toBeNull()
  })

  it('merges tag sets element by element', () => {
    let t = 0
    const at = (dev: string) => () => `${String(++t).padStart(16, '0')}-0000-${dev}`
    const base = stampChanges('paper', null, { id: 'p', tags: ['ml'] }, false, at('x'))!
    const left = stampChanges('paper', base, { id: 'p', tags: ['ml', 'nlp'] }, false, at('a'))!
    const right = stampChanges('paper', base, { id: 'p', tags: ['vision'] }, false, at('b'))!
    expect((mergeRecord(left, right)!.d['tags'] as string[]).sort()).toEqual(['nlp', 'vision'])
    expect((mergeRecord(right, left)!.d['tags'] as string[]).sort()).toEqual(['nlp', 'vision'])
  })
})

describe('merge3', () => {
  it('merges edits to different lines', () => {
    expect(merge3('a\nb\nc', 'A\nb\nc', 'a\nb\nC')).toBe('A\nb\nC')
    expect(merge3('a\nb', 'a\nb\nx', 'z\na\nb')).toBe('z\na\nb\nx')
  })
  it('accepts the same edit on both sides and reports real conflicts', () => {
    expect(merge3('a\nb', 'a\nB', 'a\nB')).toBe('a\nB')
    expect(merge3('a\nb\nc', 'a\nX\nc', 'a\nY\nc')).toBeNull()
  })
})

describe('sync engine', () => {
  it('moves papers, folders, annotations, terms and tag colours between devices', async () => {
    const { a, b } = await pair()
    const p = a.lib.addPaper(meta('Attention Is All You Need', { identifiers: { arxiv: '1706.03762' } }))
    a.lib.updatePaper(p.id, { tags: ['transformer'], readingStatus: 'reading', readingPosition: { fileHash: 'h', page: 3, left: 0, top: 0, scale: 'page-width', updatedAt: tick() } })
    const f = a.lib.createFolder('NLP')
    a.lib.updatePaper(p.id, { folderIds: [f.id] })
    a.lib.setTagColor('transformer', 'blue')
    a.lib.addTerm({ term: 'attention', translation: '注意力' })
    const an = a.lib.addAnnotation({ paperId: p.id, fileHash: 'h', type: 'highlight', origin: 'select', color: 'yellow', page: 0, target: { rects: [[0, 0, 10, 10]], quote: { exact: 'x', prefix: '', suffix: '' } } })

    expect((await a.engine.sync()).sent).toBeGreaterThan(0)
    const r = await b.engine.sync()
    expect(r.received).toBeGreaterThan(0)

    const got = b.lib.getPaper(p.id)!
    expect(got.title).toBe('Attention Is All You Need')
    expect(got.tags).toEqual(['transformer'])
    expect(got.folderIds).toEqual([f.id])
    expect(got.readingStatus).toBe('reading')
    // 阅读位置每台设备自己记
    expect(got.readingPosition).toBeUndefined()
    expect(b.lib.findDuplicate({ arxiv: '1706.03762' })?.paper.id).toBe(p.id)
    expect(b.lib.listFolders().map((x) => x.name)).toEqual(['NLP'])
    expect(b.lib.tagColors()).toEqual({ transformer: 'blue' })
    expect(b.lib.listTerms().map((t) => t.translation)).toEqual(['注意力'])
    expect(b.lib.getAnnotation(an.id)?.color).toBe('yellow')

    // 收到的修改不会被当成本机修改再发一遍
    expect((await b.engine.sync()).sent).toBe(0)
  })

  it('merges concurrent offline edits on both devices', async () => {
    const { a, b } = await pair()
    const p = a.lib.addPaper(meta('Paper'))
    await a.engine.sync()
    await b.engine.sync()

    a.lib.updatePaper(p.id, { title: 'Paper (camera ready)', tags: ['ml'] })
    b.lib.updatePaper(p.id, { readingStatus: 'done', tags: ['to-cite'] })
    b.lib.setTagColor('to-cite', 'red')
    a.lib.setTagColor('ml', 'green')
    await a.engine.sync()
    await b.engine.sync()
    await a.engine.sync()

    for (const lib of [a.lib, b.lib]) {
      const x = lib.getPaper(p.id)!
      expect(x.title).toBe('Paper (camera ready)')
      expect(x.readingStatus).toBe('done')
      expect([...x.tags].sort()).toEqual(['ml', 'to-cite'])
      expect(lib.tagColors()).toEqual({ ml: 'green', 'to-cite': 'red' })
    }
  })

  it('syncs deletions and keeps an edit made after the delete for when it is restored', async () => {
    const { a, b } = await pair()
    const p = a.lib.addPaper(meta('Gone'))
    await a.engine.sync()
    await b.engine.sync()
    a.lib.removePaper(p.id)
    b.lib.updatePaper(p.id, { rating: 5 })
    await a.engine.sync()
    await b.engine.sync()
    await a.engine.sync()
    expect(a.lib.getPaper(p.id)).toBeNull()
    expect(b.lib.getPaper(p.id)).toBeNull()
    b.lib.restorePaper(p.id)
    await b.engine.sync()
    await a.engine.sync()
    expect(a.lib.getPaper(p.id)?.rating).toBe(5)
  })

  it('does not lose an edit made while a sync was pulling', async () => {
    const { a, b } = await pair()
    const p = a.lib.addPaper(meta('Race'))
    await a.engine.sync()
    await b.engine.sync()
    a.lib.updatePaper(p.id, { title: 'Race 2' })
    await a.engine.sync()
    // b 改了阅读状态，还没同步；合并 a 的修改时不能把它盖掉
    b.lib.updatePaper(p.id, { readingStatus: 'to_read' })
    await b.engine.sync()
    await a.engine.sync()
    expect(a.lib.getPaper(p.id)).toMatchObject({ title: 'Race 2', readingStatus: 'to_read' })
    expect(b.lib.getPaper(p.id)).toMatchObject({ title: 'Race 2', readingStatus: 'to_read' })
  })

  it('merges notes edited on both devices, and keeps a conflict copy when the same line changed', async () => {
    const { a, b } = await pair()
    a.notes.put({ id: 'n1', title: '读书笔记', createdAt: tick(), body: '第一行\n第二行\n第三行' })
    await a.engine.sync()
    await b.engine.sync()
    expect(b.notes.docs.get('n1')?.body).toBe('第一行\n第二行\n第三行')

    a.notes.put({ ...a.notes.docs.get('n1')!, body: '第一行（Mac）\n第二行\n第三行' })
    b.notes.put({ ...b.notes.docs.get('n1')!, body: '第一行\n第二行\n第三行（iPad）' })
    await a.engine.sync()
    await b.engine.sync()
    await a.engine.sync()
    expect(a.notes.docs.get('n1')?.body).toBe('第一行（Mac）\n第二行\n第三行（iPad）')
    expect(b.notes.docs.get('n1')?.body).toBe('第一行（Mac）\n第二行\n第三行（iPad）')

    a.notes.put({ ...a.notes.docs.get('n1')!, body: 'Mac 改的\n第二行\n第三行（iPad）' })
    b.notes.put({ ...b.notes.docs.get('n1')!, body: 'iPad 改的\n第二行\n第三行（iPad）' })
    await a.engine.sync()
    await b.engine.sync()
    await a.engine.sync()
    await b.engine.sync()
    expect(b.notes.docs.get('n1')?.body).toBe(a.notes.docs.get('n1')?.body)
    const copies = (n: ReturnType<typeof memNotes>) => [...n.docs.values()].filter((d) => d.title.includes('冲突副本'))
    expect(copies(a.notes)).toHaveLength(1)
    expect(copies(b.notes)).toHaveLength(1)
    expect([a.notes.docs.get('n1')!.body, copies(a.notes)[0]!.body].sort()).toEqual(['Mac 改的\n第二行\n第三行（iPad）', 'iPad 改的\n第二行\n第三行（iPad）'].sort())

    // 删除
    a.notes.remove('n1')
    await a.engine.sync()
    await b.engine.sync()
    expect(b.notes.docs.has('n1')).toBe(false)
  })

  it('compacts its own log into a snapshot that a new device can start from', async () => {
    const { backend, a } = await pair()
    for (let i = 0; i < 7; i++) {
      a.lib.addPaper(meta(`Paper ${i}`))
      await a.engine.sync()
    }
    const logs = [...backend.files.keys()].filter((k) => k.startsWith(`log/${a.lib.deviceId}/`))
    expect(logs.length).toBeLessThan(5)
    expect([...backend.files.keys()].some((k) => k.startsWith('snap/'))).toBe(true)
    const { key } = { key: await unlockLibrary((await readLibraryInfo(backend))!, nodeCodec, 'correct horse') }
    const c = device(backend, key, 'Phone')
    await c.engine.sync()
    expect(c.lib.listPapers()).toHaveLength(7)
  })

  it('encrypts everything and refuses a wrong password', async () => {
    const { backend, a } = await pair('s3cret')
    a.lib.addPaper(meta('Secret Paper Title'))
    a.notes.put({ id: 'n', title: 'secret note', createdAt: tick(), body: 'private body' })
    await a.engine.sync()
    for (const [path, data] of backend.files) {
      if (path === 'flax.json') continue
      expect(Buffer.from(data).toString('latin1')).not.toContain('Secret')
      expect(Buffer.from(data).toString('latin1')).not.toContain('private')
    }
    const info = (await readLibraryInfo(backend))!
    await expect(unlockLibrary(info, nodeCodec, 'wrong')).rejects.toBeInstanceOf(WrongKeyError)
    expect(await unlockLibrary(info, nodeCodec, 's3cret')).toBeInstanceOf(Uint8Array)
  })

  it('works without encryption and moves PDFs', async () => {
    const { a, b } = await pair(null)
    a.lib.addPaper(meta('Open'))
    await a.engine.sync()
    await b.engine.sync()
    expect(b.lib.listPapers()).toHaveLength(1)
    await a.engine.putFile('ab'.repeat(32), new Uint8Array([1, 2, 3]))
    expect([...(await b.engine.getFile('ab'.repeat(32)))!]).toEqual([1, 2, 3])
    expect(await b.engine.getFile('cd'.repeat(32))).toBeNull()
  })

  it('starts over when pointed at a different cloud library', async () => {
    const one = memoryBackend()
    const { key } = await createLibrary(one, nodeCodec, null)
    const a = device(one, key, 'Mac')
    a.lib.addPaper(meta('Mine'))
    await a.engine.sync()
    const two = memoryBackend()
    await createLibrary(two, nodeCodec, null)
    const a2 = new SyncEngine({ backend: two, codec: nodeCodec, stores: [a.lib.syncStore()], state: { get: (k) => a.lib.metaGet(k), set: (k, v) => a.lib.metaSet(k, v) }, deviceId: a.lib.deviceId, deviceName: 'Mac', platform: 'test', key: null })
    expect((await a2.sync()).sent).toBe(1)
  })
})

describe('webdav', () => {
  it('reads PROPFIND listings with any namespace prefix', () => {
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/dav/Flax/log/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
      <d:response><d:href>/dav/Flax/log/dev-1/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
      <d:response><d:href>/dav/Flax/log/a%20b.flx</d:href><d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response>
    </d:multistatus>`
    expect(parseMultistatus(xml, 'https://dav.jianguoyun.com/dav/Flax/log/')).toEqual(['dev-1/', 'a b.flx'])
    const bare = `<multistatus xmlns="DAV:"><response><href>https://h/x/Flax/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response><response><href>https://h/x/Flax/flax.json</href></response></multistatus>`
    expect(parseMultistatus(bare, 'https://h/x/Flax/')).toEqual(['flax.json'])
  })

  it('talks to a WebDAV server: creates folders, lists, reads, deletes', async () => {
    const srv = await webdavServer('me@example.com', 'app-pass')
    try {
      const dav = webdav({ url: srv.url, username: 'me@example.com', password: 'app-pass', fetch: (u, i) => fetch(u, i as RequestInit) })
      expect(await dav.list('log/')).toBeNull()
      expect(await dav.get('flax.json')).toBeNull()
      await dav.put('log/dev 1/0000000001.flx', new Uint8Array([7]))
      expect(srv.dirs.has('/dav/Flax/log/dev 1/')).toBe(true)
      expect(await dav.list('log/')).toEqual(['dev 1/'])
      expect(await dav.list('log/dev 1/')).toEqual(['0000000001.flx'])
      expect([...(await dav.get('log/dev 1/0000000001.flx'))!]).toEqual([7])
      await dav.del('log/dev 1/0000000001.flx')
      expect(await dav.list('log/dev 1/')).toEqual([])
      const wrong = webdav({ url: srv.url, username: 'me@example.com', password: 'nope', fetch: (u, i) => fetch(u, i as RequestInit) })
      await expect(wrong.get('flax.json')).rejects.toMatchObject({ code: 'auth' })
      expect(SyncError).toBeTruthy()
    } finally {
      await srv.close()
    }
  })

  it('syncs two devices through a WebDAV server end to end', async () => {
    const srv = await webdavServer()
    try {
      const dav = () => webdav({ url: srv.url, username: 'u', password: 'p', fetch: (u, i) => fetch(u, i as RequestInit) })
      const { key } = await createLibrary(dav(), nodeCodec, 'pw-123456')
      const a = device(dav() as ReturnType<typeof memoryBackend>, key, 'Mac')
      const b = device(dav() as ReturnType<typeof memoryBackend>, key, 'Win')
      const p = a.lib.addPaper(meta('Over WebDAV'))
      await a.engine.sync()
      await b.engine.sync()
      expect(b.lib.getPaper(p.id)?.title).toBe('Over WebDAV')
      // 没有修改时同步只用几个请求（坚果云免费版有请求次数限制）
      const before = srv.log.length
      await b.engine.sync()
      expect(srv.log.length - before).toBeLessThanOrEqual(5)
    } finally {
      await srv.close()
    }
  })
})
