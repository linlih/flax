import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Library, type FetchText } from '@flax/core'
import type { ImportNotice } from '../shared/api'
import { Importer } from './importer'
import type { FetchBytes } from './net'
import { FileStore, sha256 } from './store'
import { makePdf } from './testing/makePdf'

// 编的 arXiv 响应，只模仿结构
const feed = (id: string, title: string) => `<feed><entry><id>http://arxiv.org/abs/${id}v1</id><published>2021-01-05T00:00:00Z</published><title>${title}</title><summary>s</summary><author><name>Ada Lovelace</name></author></entry></feed>`

const arxivPdf = (id: string, variant = '') =>
  makePdf([[{ text: `arXiv:${id}v1 [cs.LG] 5 Jan 2021`, size: 10, y: 300, x: 20 }, { text: `Some Title ${variant}`, size: 18, y: 700 }]])

let dir: string
let files: Record<string, Uint8Array>
let notices: ImportNotice[]
let calls: string[]
let online: boolean
let pdfs: Record<string, Uint8Array>
/** 其他网站的链接能下到什么 */
let web: Record<string, Uint8Array>
let lib: Library
let store: FileStore
let importer: Importer

const fetchText: FetchText = async (url) => {
  calls.push(url)
  if (!online) throw new Error('offline')
  const id = /id_list=([\d.]+)/.exec(url)?.[1]
  if (url.includes('openlibrary.org')) return { status: 200, body: url.includes('9780306406157') ? JSON.stringify({ 'ISBN:9780306406157': { title: 'A Field Guide to Examples', authors: [{ name: 'Grace Hopper' }], publishers: [{ name: 'Example Press' }], publish_date: '2017' } }) : '{}' }
  if (id === '2101.01234') return { status: 200, body: feed(id, 'Sparse Mixtures for Long Documents') }
  return { status: 200, body: '<feed></feed>' }
}

// 编的 arXiv PDF 下载：只认 pdfs 里有的编号
const fetchBytes: FetchBytes = async (url) => {
  calls.push(url)
  if (!online) throw new Error('offline')
  const id = /arxiv\.org\/pdf\/(.+)$/.exec(url)?.[1] ?? ''
  const body = pdfs[id] ?? web[url]
  return body ? { status: 200, body } : { status: 404, body: new Uint8Array() }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'paper-import-'))
  files = {}
  notices = []
  calls = []
  online = true
  pdfs = { '2101.01234': arxivPdf('2101.01234', 'from arXiv') }
  web = {}
  lib = new Library(new DatabaseSync(':memory:'))
  store = new FileStore(dir)
  importer = new Importer({
    library: lib,
    store,
    fetchText,
    fetchBytes,
    onChanged: () => {},
    onNotice: (n) => notices.push(n),
    read: async (p) => {
      const f = files[p]
      if (!f) throw new Error(`ENOENT ${p}`)
      return f
    }
  })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('Importer', () => {
  it('stores the file by hash, shows a row at once, then fills metadata', async () => {
    files['/in/a.pdf'] = arxivPdf('2101.01234')
    await importer.importPaths(['/in/a.pdf'])
    const [row] = lib.listPapers()
    expect(row?.files[0]?.originalName).toBe('a.pdf')
    expect(statSync(store.pathFor(sha256(files['/in/a.pdf']!))).size).toBeGreaterThan(0)
    await importer.whenIdle()
    expect(lib.listPapers()[0]).toMatchObject({ title: 'Sparse Mixtures for Long Documents', needsMatch: false, metadataSource: 'arxiv', identifiers: { arxiv: '2101.01234' } })
    expect(importer.importingIds()).toEqual([])
  })

  it('reports the same file without adding a row', async () => {
    files['/in/a.pdf'] = arxivPdf('2101.01234')
    files['/in/copy.pdf'] = files['/in/a.pdf']
    await importer.importPaths(['/in/a.pdf'])
    await importer.whenIdle()
    await importer.importPaths(['/in/copy.pdf'])
    expect(lib.listPapers()).toHaveLength(1)
    expect(notices).toEqual([expect.objectContaining({ kind: 'same_file' })])
  })

  it('asks before adding a different file of a known paper, then adds it as a version', async () => {
    files['/in/a.pdf'] = arxivPdf('2101.01234', 'v1')
    files['/in/b.pdf'] = arxivPdf('2101.01234', 'camera ready')
    await importer.importPaths(['/in/a.pdf'])
    await importer.whenIdle()
    await importer.importPaths(['/in/b.pdf'])
    const n = notices[0]
    expect(n).toMatchObject({ kind: 'same_paper', fileName: 'b.pdf' })
    expect(lib.listPapers()).toHaveLength(1)
    importer.resolveDuplicate((n as { token: string }).token, 'add_version')
    expect(lib.listPapers()[0]?.files.map((f) => f.role)).toEqual(['main', 'preprint'])
  })

  it('keeps the PDF guess and flags the row when offline', async () => {
    online = false
    files['/in/a.pdf'] = arxivPdf('2101.01234')
    await importer.importPaths(['/in/a.pdf'])
    await importer.whenIdle()
    expect(lib.listPapers()[0]).toMatchObject({ needsMatch: true, matchIssue: 'lookup_failed', identifiers: { arxiv: '2101.01234' } })
    online = true
    await importer.retry(lib.listPapers()[0]!.id)
    expect(lib.listPapers()[0]).toMatchObject({ needsMatch: false, title: 'Sparse Mixtures for Long Documents' })
  })

  it('does not go online for a PDF without any id', async () => {
    files['/in/scan.pdf'] = makePdf([[{ text: 'Lecture Notes on Optimisation', size: 20, y: 700 }]])
    await importer.importPaths(['/in/scan.pdf'])
    await importer.whenIdle()
    expect(lib.listPapers()[0]).toMatchObject({ title: 'Lecture Notes on Optimisation', needsMatch: true, matchIssue: 'no_id' })
    expect(calls).toEqual([])
  })

  it('finds the ISBN on the copyright page of a book and fills in the details', async () => {
    const pages = Array.from({ length: 60 }, (_, i) => [{ text: i === 3 ? 'ISBN 978-0-306-40615-7' : `Chapter text ${i}`, size: 10, y: 700 }])
    files['/in/book.pdf'] = makePdf(pages)
    await importer.importPaths(['/in/book.pdf'])
    await importer.whenIdle()
    expect(lib.listPapers()[0]).toMatchObject({ title: 'A Field Guide to Examples', venue: 'Example Press', year: 2017, needsMatch: false, metadataSource: 'openlibrary', identifiers: { isbn: '9780306406157' } })
    // 同一本书的另一个文件：认出来是库里已有的
    files['/in/book2.pdf'] = makePdf([...pages, [{ text: 'extra', size: 10, y: 700 }]])
    await importer.importPaths(['/in/book2.pdf'])
    expect(lib.listPapers()).toHaveLength(1)
    expect(notices.at(-1)?.kind).toBe('same_paper')
  })

  it('does not treat a short paper that prints an ISBN as a book', async () => {
    files['/in/p.pdf'] = makePdf([[{ text: 'A Paper in Some Proceedings', size: 18, y: 700 }, { text: 'ISBN 978-0-306-40615-7', size: 8, y: 100 }]])
    await importer.importPaths(['/in/p.pdf'])
    await importer.whenIdle()
    expect(lib.listPapers()[0]).toMatchObject({ matchIssue: 'no_id', identifiers: {} })
    expect(calls).toEqual([])
  })

  it('offers AI for a book it could not identify, but not for a paper or when the lookup only failed', async () => {
    const book = (isbn: string) => Array.from({ length: 60 }, (_, i) => [{ text: i === 3 ? `ISBN ${isbn}` : `Chapter text ${i}`, size: 10, y: 700 }])
    // 这个 ISBN 假的服务里没有
    files['/in/unknown.pdf'] = makePdf(book('978-7-111-00000-6'))
    files['/in/paper.pdf'] = makePdf([[{ text: 'A Short Paper Without Any Id', size: 18, y: 700 }]])
    await importer.importPaths(['/in/unknown.pdf', '/in/paper.pdf'])
    await importer.whenIdle()
    expect(notices.filter((n) => n.kind === 'unidentified')).toEqual([{ kind: 'unidentified', paperId: lib.listPapers().find((p) => p.identifiers.isbn)!.id, fileName: 'unknown.pdf' }])
    notices = []
    online = false
    files['/in/offline.pdf'] = makePdf(book('978-0-306-40615-7'))
    await importer.importPaths(['/in/offline.pdf'])
    await importer.whenIdle()
    expect(notices).toEqual([])
  })

  it('asks about all unidentified files together, after the lookups of the batch are done', async () => {
    files['/in/scan.pdf'] = makePdf([[]])
    files['/in/unknown.pdf'] = makePdf(Array.from({ length: 60 }, (_, i) => [{ text: i === 3 ? 'ISBN 978-7-111-00000-6' : `Chapter text ${i}`, size: 10, y: 700 }]))
    await importer.importPaths(['/in/scan.pdf', '/in/unknown.pdf'])
    // 那本书还在按 ISBN 查：先不问，免得对话框弹出来以后又多一个
    expect(notices.filter((n) => n.kind === 'unidentified')).toEqual([])
    await importer.whenIdle()
    expect(notices.filter((n) => n.kind === 'unidentified').map((n) => n.fileName)).toEqual(['scan.pdf', 'unknown.pdf'])
  })

  it('uses what AI read, or the lookup when AI found an ISBN that is known', async () => {
    files['/in/scan.pdf'] = makePdf([[]])
    await importer.importPaths(['/in/scan.pdf'])
    const id = lib.listPapers()[0]!.id
    expect(notices.at(-1)).toMatchObject({ kind: 'unidentified', paperId: id })
    await importer.applyIdentified(id, { title: '深度学习', authors: [{ family: '张三' }], identifiers: {}, venue: '示例出版社', source: 'ai' })
    expect(lib.getPaper(id)).toMatchObject({ title: '深度学习', venue: '示例出版社', metadataSource: 'ai', needsMatch: false })
    await importer.applyIdentified(id, { title: 'Field Guide', authors: [], identifiers: { isbn: '9780306406157' }, source: 'ai' })
    expect(lib.getPaper(id)).toMatchObject({ title: 'A Field Guide to Examples', metadataSource: 'openlibrary', identifiers: { isbn: '9780306406157' } })
  })

  it('reports files that are not PDFs or cannot be read, and keeps going', async () => {
    files['/in/fake.pdf'] = new TextEncoder().encode('not a pdf')
    files['/in/ok.pdf'] = makePdf([[{ text: 'A Perfectly Fine Document Title', size: 20, y: 700 }]])
    await importer.importPaths(['/in/fake.pdf', '/in/missing.pdf', '/in/ok.pdf'])
    expect(notices.map((n) => n.kind)).toEqual(['not_pdf', 'failed'])
    expect(lib.listPapers()).toHaveLength(1)
  })

  it('does not overwrite a title the user edited while the lookup was running', async () => {
    files['/in/a.pdf'] = arxivPdf('2101.01234')
    await importer.importPaths(['/in/a.pdf'])
    lib.updatePaper(lib.listPapers()[0]!.id, { title: 'My Own Title' })
    await importer.whenIdle()
    expect(lib.listPapers()[0]?.title).toBe('My Own Title')
  })

  it('adds a paper from a pasted arXiv link', async () => {
    expect(await importer.addFromText('see https://arxiv.org/abs/2101.01234')).toBe(true)
    expect(lib.listPapers()[0]).toMatchObject({ title: 'Sparse Mixtures for Long Documents' })
    expect(await importer.addFromText('no id here')).toBe(false)
  })

  it('downloads and imports a pasted link to a PDF on any site', async () => {
    const url = 'https://example.org/book/se%20handbook.pdf'
    web[url] = makePdf([[{ text: 'A Handbook of Examples', size: 20, y: 700 }]])
    expect(await importer.addFromText(`看看这个 ${url}。`)).toBe(true)
    const [p] = lib.listPapers()
    expect(p?.files).toMatchObject([{ role: 'main', originalName: 'se handbook.pdf', hash: sha256(web[url]!) }])
    expect(calls).toContain(url)
    // 再贴一次：同一个文件，不重复加
    await importer.addFromText(url)
    expect(lib.listPapers()).toHaveLength(1)
    expect(notices).toContainEqual(expect.objectContaining({ kind: 'same_file', paperId: p!.id }))
  })

  it('tells why a pasted link could not be imported', async () => {
    web['https://example.org/page'] = new TextEncoder().encode('<html>not a pdf</html>')
    expect(await importer.addFromText('https://example.org/page')).toBe(true)
    expect(await importer.addFromText('https://example.org/missing.pdf')).toBe(true)
    online = false
    expect(await importer.addFromText('https://example.org/x.pdf')).toBe(true)
    expect(lib.listPapers()).toEqual([])
    expect(notices.map((n) => n.kind === 'failed' && `${n.fileName}: ${n.message}`)).toEqual([
      expect.stringMatching(/^page\.pdf: 链接打开的不是 PDF/),
      'missing.pdf: 链接打不开（404）。',
      'x.pdf: 下载失败，请检查链接和网络。'
    ])
  })

  describe('saving from a web page (browser extension)', () => {
    const page = (extra: object = {}) => ({ url: 'https://arxiv.org/abs/2101.01234v2', ...extra })

    it('looks up the paper by the id on the page and downloads the arXiv PDF', async () => {
      const r = await importer.addFromPage(page({ meta: { title: 'From the page', authors: ['Ada Lovelace'] } }))
      expect(r).toMatchObject({ status: 'added', title: 'Sparse Mixtures for Long Documents', hasPdf: true })
      const p = lib.getPaper(r!.paperId)!
      expect(p).toMatchObject({ identifiers: { arxiv: '2101.01234' }, metadataSource: 'arxiv', needsMatch: false })
      await importer.whenIdle()
      expect(lib.getPaper(p.id)!.files).toHaveLength(1)
    })

    it('keeps what the page says when the lookup fails', async () => {
      online = false
      const r = await importer.addFromPage({ url: 'https://dl.example.org/doi/10.1145/3589334.3645341', meta: { title: '  A  Paper\nFrom ACM ', authors: ['Lovelace, Ada', 'Grace Hopper', 'Grace Hopper'], year: 2024, venue: 'WWW' } })
      const p = lib.getPaper(r!.paperId)!
      expect(p).toMatchObject({
        title: 'A Paper From ACM',
        authors: [{ given: 'Ada', family: 'Lovelace' }, { given: 'Grace', family: 'Hopper' }],
        year: 2024, venue: 'WWW', identifiers: { doi: '10.1145/3589334.3645341' }, metadataSource: 'web', needsMatch: false
      })
      expect(r!.hasPdf).toBe(false)
    })

    it('marks a page with only an id and no lookup result as needing a match', async () => {
      online = false
      const r = await importer.addFromPage({ url: 'https://example.org/x', ids: { doi: '10.1000/xyz123' } })
      expect(lib.getPaper(r!.paperId)).toMatchObject({ title: '10.1000/xyz123', needsMatch: true, matchIssue: 'lookup_failed' })
    })

    it('saves a page with a title but no id, to be matched later', async () => {
      const r = await importer.addFromPage({ url: 'https://proceedings.example.org/paper/42', meta: { title: 'Untitled Conference Paper' } })
      expect(lib.getPaper(r!.paperId)).toMatchObject({ title: 'Untitled Conference Paper', needsMatch: true, matchIssue: 'no_id' })
    })

    it('does not add the same paper twice and tells the extension it is already there', async () => {
      const first = await importer.addFromPage(page())
      await importer.whenIdle()
      expect(importer.findPage({ url: 'https://arxiv.org/pdf/2101.01234' })).toMatchObject({ paperId: first!.paperId, hasPdf: true })
      const again = await importer.addFromPage({ url: 'https://example.org/', ids: { arxiv: 'arXiv:2101.01234' } })
      expect(again).toMatchObject({ status: 'existing', paperId: first!.paperId })
      expect(lib.listPapers()).toHaveLength(1)
    })

    it('saves a PDF opened directly in the tab by downloading it', async () => {
      const url = 'https://someone.github.io/book/handbook.pdf'
      web[url] = makePdf([[{ text: 'A Handbook of Examples', size: 20, y: 700 }]])
      const r = await importer.addFromPage({ url, isPdf: true })
      expect(r).toMatchObject({ status: 'added', hasPdf: true })
      const p = lib.getPaper(r!.paperId)!
      expect(p.files).toHaveLength(1)
      expect(p.files[0]).toMatchObject({ role: 'main', originalName: 'handbook.pdf', hash: sha256(web[url]!) })
      // 再存一次：同一个文件，不再加一篇
      expect(await importer.addFromPage({ url, isPdf: true })).toMatchObject({ status: 'existing', paperId: p.id })
      expect(lib.listPapers()).toHaveLength(1)
    })

    it('tells the extension why a PDF tab could not be saved', async () => {
      await expect(importer.addFromPage({ url: 'https://example.org/gone.pdf', isPdf: true })).rejects.toThrow('链接打不开（404）。')
      web['https://example.org/viewer.pdf'] = new TextEncoder().encode('<html>sign in</html>')
      await expect(importer.addFromPage({ url: 'https://example.org/viewer.pdf', isPdf: true })).rejects.toThrow(/不是 PDF/)
      await expect(importer.addFromPage({ url: 'file:///Users/me/a.pdf', isPdf: true })).rejects.toThrow(/http/)
      expect(lib.listPapers()).toEqual([])
    })

    it('saves an arXiv PDF tab by its id, with the details from arXiv', async () => {
      const r = await importer.addFromPage({ url: 'https://arxiv.org/pdf/2101.01234v2', isPdf: true })
      expect(lib.getPaper(r!.paperId)).toMatchObject({ title: 'Sparse Mixtures for Long Documents', metadataSource: 'arxiv' })
    })

    it('ignores ids and fields that are not what they claim to be', async () => {
      expect(await importer.addFromPage({ url: 'https://example.org/', ids: { doi: 'javascript:alert(1)', arxiv: 42 as unknown as string } })).toBeNull()
      expect(await importer.addFromPage({ url: 'https://example.org/', meta: { title: '   ', authors: [{} as unknown as string] } })).toBeNull()
      expect(importer.findPage({ url: 'https://example.org/' })).toBeNull()
      expect(lib.listPapers()).toEqual([])
    })
  })

  it('downloads the PDF from arXiv after a pasted link', async () => {
    await importer.addFromText('https://arxiv.org/abs/2101.01234')
    const id = lib.listPapers()[0]!.id
    expect(importer.downloadingIds()).toEqual([id])
    await importer.whenIdle()
    const p = lib.getPaper(id)!
    expect(p.files).toHaveLength(1)
    expect(p.files[0]).toMatchObject({ role: 'main', originalName: '2101.01234.pdf', pageCount: 1, hash: sha256(pdfs['2101.01234']!) })
    expect(statSync(store.pathFor(p.files[0]!.hash)).size).toBe(pdfs['2101.01234']!.byteLength)
    expect(calls).toContain('https://arxiv.org/pdf/2101.01234')
    expect(importer.downloadingIds()).toEqual([])
  })

  it('reports a failed download and can try again', async () => {
    online = false
    await importer.addFromText('arXiv:2101.01234')
    await importer.whenIdle()
    const id = lib.listPapers()[0]!.id
    expect(lib.getPaper(id)!.files).toEqual([])
    expect(notices).toContainEqual(expect.objectContaining({ kind: 'download_failed', paperId: id }))
    online = true
    expect(importer.startDownload(id)).toBe(true)
    await importer.whenIdle()
    expect(lib.getPaper(id)!.files).toHaveLength(1)
  })

  it('does not download for a paper that already has a PDF', async () => {
    files['/a.pdf'] = arxivPdf('2101.01234')
    await importer.importPaths(['/a.pdf'])
    await importer.whenIdle()
    const id = lib.listPapers()[0]!.id
    expect(importer.startDownload(id)).toBe(false)
    expect(calls.some((u) => u.includes('/pdf/'))).toBe(false)
  })

  it('gives a dropped PDF to the matching paper that has no file yet, without asking', async () => {
    online = false
    await importer.addFromText('arXiv:2101.01234')
    await importer.whenIdle()
    const id = lib.listPapers()[0]!.id
    files['/mine.pdf'] = arxivPdf('2101.01234', 'mine')
    await importer.importPaths(['/mine.pdf'])
    expect(lib.listPapers()).toHaveLength(1)
    expect(lib.getPaper(id)!.files).toMatchObject([{ role: 'main', originalName: 'mine.pdf' }])
    expect(notices).toContainEqual(expect.objectContaining({ kind: 'attached', paperId: id }))
    expect(notices.some((n) => n.kind === 'same_paper')).toBe(false)
  })
})

describe('BibTeX import (Zotero)', () => {
  it('adds papers with their PDFs, skips ones already in the library and counts missing files', async () => {
    files['/z/storage/A/vaswani.pdf'] = makePdf([[{ text: 'Attention body', size: 12, y: 700 }]])
    lib.addPaper({ title: 'Already Here', authors: [], identifiers: { doi: '10.1/known' }, source: 'user' })
    const bib = `
@inproceedings{v2017, title = {Attention Is All You Need}, author = {Vaswani, Ashish}, year = {2017}, keywords = {nlp},
  file = {Full Text PDF:/z/storage/A/vaswani.pdf:application/pdf}}
@article{k, title = {Already Here Again}, doi = {10.1/known}}
@article{m, title = {Missing File Paper}, file = {/z/storage/B/gone.pdf}}
`
    const r = await importer.importBibTeX(bib)
    expect(r).toEqual({ added: 2, existing: 1, missingFiles: 1 })
    const att = lib.listPapers().find((p) => p.title === 'Attention Is All You Need')!
    expect(att.files).toHaveLength(1)
    expect(att.tags).toEqual(['nlp'])
    expect(att.needsMatch).toBe(false)
    expect(lib.listPapers().find((p) => p.title === 'Missing File Paper')!.files).toHaveLength(0)
    expect(calls).toEqual([])
  })
})

describe('relink a missing PDF', () => {
  it('makes the chosen file the main file, refuses non-PDFs and files of other papers', async () => {
    files['/in/a.pdf'] = makePdf([[{ text: 'First body', size: 12, y: 700 }]])
    files['/in/b.pdf'] = makePdf([[{ text: 'Second body', size: 12, y: 700 }]])
    files['/in/new.pdf'] = makePdf([[{ text: 'Replacement body', size: 12, y: 700 }]])
    files['/in/x.txt'] = new TextEncoder().encode('not a pdf')
    await importer.importPaths(['/in/a.pdf', '/in/b.pdf'])
    const [a, b] = lib.listPapers().sort((x, y) => x.files[0]!.originalName!.localeCompare(y.files[0]!.originalName!))
    expect(await importer.relink(a!.id, '/in/x.txt')).toBe('not_pdf')
    expect(await importer.relink(a!.id, '/in/b.pdf')).toBe('other_paper')
    expect(await importer.relink(a!.id, '/in/new.pdf')).toBe('ok')
    const after = lib.getPaper(a!.id)!
    expect(after.files.map((f) => [f.originalName, f.role])).toEqual([['new.pdf', 'main']])
    expect(lib.getPaper(b!.id)!.files).toHaveLength(1)
  })
})
