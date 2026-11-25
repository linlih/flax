import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { arxivVersionIn, ensureWebCopy, htmlKey, type HtmlFiles, type HtmlGet, type WebCopyDeps } from './arxivHtml'
import { Library } from './library'
import { buildPdfText, pageFromItems, pdfPageOf, rectsOnPage } from './pdfText'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
const PAGE = `<html><head><script>evil()</script></head><body><a href="/abs/2310.06825v1">back</a>
<article class="ltx_document"><div class="ltx_para"><p>One.</p></div><div class="ltx_para"><p>Two.</p></div><div class="ltx_para"><p>Three.</p></div>
<img src="2310.06825v1/x1.png" alt="fig"><img src="https://static.arxiv.org/logo.svg"><img src="data:image/png;base64,AAAA"></article></body></html>`

/** 旧的缓存文件夹 */
function cache(): HtmlFiles & { data: Map<string, string | Uint8Array> } {
  const data = new Map<string, string | Uint8Array>()
  return {
    data,
    readText: async (k, n) => (data.get(`${k}/${n}`) as string | undefined) ?? null,
    readBytes: async (k, n) => (data.get(`${k}/${n}`) as Uint8Array | undefined) ?? null,
    writeText: async (k, n, t) => void data.set(`${k}/${n}`, t)
  }
}

/** 一篇论文、一个按哈希存文件的地方（哈希用内容本身，测试里够用） */
function setup(get: HtmlGet, extra: Partial<WebCopyDeps> = {}) {
  const library = new Library(new DatabaseSync(':memory:'))
  const paper = library.addPaper({ title: 'Mistral 7B', authors: [], identifiers: { arxiv: '2310.06825' }, metadataSource: 'arxiv' })
  const stored = new Map<string, Uint8Array>()
  const store = { has: (h: string) => stored.has(h), put: async (b: Uint8Array) => (stored.set(`h${stored.size + 1}`, b), `h${stored.size}`) }
  const files = cache()
  const d: WebCopyDeps = { library, store, get, cache: files, ...extra }
  return { library, paper, stored, files, d }
}

describe('arXiv HTML copies', () => {
  it('downloads the page once, puts its figures inside it, and records it on the paper', async () => {
    const asked: string[] = []
    const get: HtmlGet = async (url) => {
      asked.push(url)
      if (url === 'https://arxiv.org/html/2310.06825v1') return { status: 200, body: enc(PAGE) }
      if (url === 'https://arxiv.org/html/2310.06825v1/x1.png') return { status: 200, body: new Uint8Array([1, 2, 3]), type: 'image/png' }
      return { status: 404, body: new Uint8Array() }
    }
    const { library, paper, stored, d } = setup(get)
    const r = await ensureWebCopy(paper.id, '2310.06825', 'v1', d)
    expect(r).toEqual({ ok: true, hash: 'h1', version: 'v1' })
    const html = dec(stored.get('h1')!)
    expect(html).toContain('src="data:image/png;base64,AQID"')
    expect(html).toContain('src="https://static.arxiv.org/logo.svg"')
    expect(asked).not.toContain('https://static.arxiv.org/logo.svg')
    const p = library.getPaper(paper.id)!
    expect(p.webCopies).toEqual([{ hash: 'h1', size: stored.get('h1')!.byteLength, want: 'v1', version: 'v1', addedAt: expect.any(String) }])
    // 同步传它、清理时不删它、能按哈希找到这篇
    expect(library.liveFileHashes()).toContain('h1')
    expect(library.takeOrphanFiles()).toEqual([])
    expect(library.findDuplicate({ hash: 'h1' })?.paper.id).toBe(paper.id)
    // 第二次直接用存好的
    asked.length = 0
    expect(await ensureWebCopy(paper.id, '2310.06825', 'v1', d)).toEqual({ ok: true, hash: 'h1', version: 'v1' })
    expect(asked).toEqual([])
  })

  it('puts SVG figures that arXiv keeps in <object> inside the page too', async () => {
    const svgPage = PAGE.replace('</article>', '<figure><object type="image/svg+xml" data="2310.06825v1/fig.svg" id="S1.F1.g1" class="ltx_graphics" width="476" height="99"></object></figure></article>')
    const get: HtmlGet = async (url) => {
      if (url === 'https://arxiv.org/html/2310.06825v1') return { status: 200, body: enc(svgPage) }
      if (url === 'https://arxiv.org/html/2310.06825v1/fig.svg') return { status: 200, body: enc('<svg/>'), type: 'image/svg+xml' }
      return { status: 404, body: new Uint8Array() }
    }
    const { paper, stored, d } = setup(get)
    await ensureWebCopy(paper.id, '2310.06825', 'v1', d)
    const html = dec(stored.get('h1')!)
    expect(html).not.toContain('<object')
    expect(html).toContain(`<img src="data:image/svg+xml;base64,${btoa('<svg/>')}" id="S1.F1.g1" class="ltx_graphics" width="476" height="99">`)
  })

  it('gets a copy missing on this device from sync first, and only then from arXiv', async () => {
    let asked = 0
    const get: HtmlGet = async () => (asked++, { status: 200, body: enc(PAGE) })
    const synced: string[] = []
    const { library, paper, stored, d } = setup(get, { fetchSynced: async (h) => (synced.push(h), stored.set(h, enc('from sync')), true) })
    library.addWebCopy(paper.id, { hash: 'abc', size: 9, want: 'v1', version: 'v1', addedAt: 'x' })
    expect(await ensureWebCopy(paper.id, '2310.06825', 'v1', d)).toEqual({ ok: true, hash: 'abc', version: 'v1' })
    expect(synced).toEqual(['abc'])
    expect(asked).toBe(0)
    // 云端也没有：去 arXiv 下载，换掉记录里的那份
    stored.clear()
    d.fetchSynced = async () => false
    const r = await ensureWebCopy(paper.id, '2310.06825', 'v1', d)
    expect(r).toMatchObject({ ok: true, hash: 'h1' })
    expect(asked).toBeGreaterThan(0)
    expect(library.getPaper(paper.id)!.webCopies!.map((c) => c.hash)).toEqual(['h1'])
  })

  it('packs a copy saved by an older version without downloading it again', async () => {
    const asked: string[] = []
    const get: HtmlGet = async (url) => (asked.push(url), { status: 200, body: enc(PAGE) })
    const { library, paper, stored, files, d } = setup(get)
    files.data.set('2310.06825v1/meta.json', JSON.stringify({ ok: true, id: '2310.06825', version: 'v1', images: 1 }))
    files.data.set('2310.06825v1/index.html', '<article><img src="img/1.png" alt="a"><img src="img/2.svg"></article>')
    files.data.set('2310.06825v1/img/1.png', new Uint8Array([1, 2, 3]))
    expect(await ensureWebCopy(paper.id, '2310.06825', 'v1', d)).toEqual({ ok: true, hash: 'h1', version: 'v1' })
    expect(asked).toEqual([])
    // 少了的图留着原样（显示时会被拿掉）
    expect(dec(stored.get('h1')!)).toBe('<article><img src="data:image/png;base64,AQID" alt="a"><img src="img/2.svg"></article>')
    expect(library.getPaper(paper.id)!.webCopies![0]).toMatchObject({ want: 'v1', version: 'v1' })
    // 旧格式、<object> 里的图没存的：重新下载
    files.data.set('2302.04761/meta.json', JSON.stringify({ ok: true, version: 'v1' }))
    files.data.set('2302.04761/index.html', '<object type="image/svg+xml" data="2302.04761v1/a.svg"></object>')
    await ensureWebCopy(paper.id, '2302.04761', null, d)
    expect(asked[0]).toBe('https://arxiv.org/html/2302.04761')
  })

  it('remembers papers without an HTML version for a while', async () => {
    let n = 0
    const get: HtmlGet = async () => (n++, { status: 404, body: new Uint8Array() })
    let now = 0
    const { paper, d } = setup(get, { now: () => now })
    expect(await ensureWebCopy(paper.id, '1412.6980', 'v9', d)).toEqual({ ok: false, reason: 'none' })
    expect(await ensureWebCopy(paper.id, '1412.6980', 'v9', d)).toEqual({ ok: false, reason: 'none' })
    expect(n).toBe(1)
    now = 8 * 24 * 3600_000
    await ensureWebCopy(paper.id, '1412.6980', 'v9', d)
    expect(n).toBe(2)
  })

  it('treats a failed conversion as no HTML, and a network error as try again', async () => {
    const { paper, d } = setup(async () => ({ status: 200, body: enc('<html>Untitled Document</html>') }))
    expect(await ensureWebCopy(paper.id, '2401.00001', null, d)).toEqual({ ok: false, reason: 'none' })
    d.get = async () => Promise.reject(new Error('offline'))
    expect(await ensureWebCopy(paper.id, '2401.00002', null, d)).toMatchObject({ ok: false, reason: 'offline' })
  })

  it('forgets the copies of a permanently deleted paper so their files can go', async () => {
    const { library, paper, d } = setup(async () => ({ status: 200, body: enc(PAGE) }))
    await ensureWebCopy(paper.id, '2310.06825', 'v1', d)
    library.removePaper(paper.id)
    library.purgePaper(paper.id)
    expect(library.takeOrphanFiles()).toEqual(['h1'])
  })

  it('reads the version off the arXiv stamp and builds safe folder names', () => {
    expect(arxivVersionIn('arXiv:1706.03762v7 [cs.CL] 2 Aug 2023', '1706.03762')).toBe('v7')
    expect(arxivVersionIn('arXiv:1706.03762 [cs.CL]', '1706.03762')).toBeNull()
    expect(htmlKey('hep-th/9901001', 'v2')).toBe('hep-th_9901001v2')
  })
})

describe('PDF text geometry', () => {
  const page = pageFromItems([
    { str: 'Hello ', transform: [10, 0, 0, 10, 100, 700], width: 60, height: 10 },
    { str: 'world', hasEOL: true, transform: [10, 0, 0, 10, 160, 700], width: 50, height: 10 },
    { str: 'Second line', transform: [10, 0, 0, 10, 100, 686], width: 110, height: 10 }
  ])
  const t = buildPdfText([page, pageFromItems([{ str: 'Page two', transform: [10, 0, 0, 10, 100, 700], width: 80, height: 10 }])])

  it('joins pages the way the text layer does', () => {
    expect(page.text).toBe('Hello world\nSecond line')
    expect(t.all).toBe('Hello world\nSecond line\nPage two')
    expect(pdfPageOf(t, t.all.indexOf('Page'))).toBe(1)
    expect(pdfPageOf(t, 3)).toBe(0)
  })

  it('turns a text range into one rect per line', () => {
    const r = rectsOnPage(t, 0, 6, 18)
    expect(r).toHaveLength(2)
    expect(r[0]![0]).toBeCloseTo(160)
    expect(r[0]![2]).toBeCloseTo(210)
    expect(r[1]![0]).toBeCloseTo(100)
    expect(r[1]![2]).toBeCloseTo(160)
  })
})
