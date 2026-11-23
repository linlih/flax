import { describe, expect, it } from 'vitest'
import { arxivVersionIn, ensureArxivHtml, htmlKey, type HtmlFiles } from './arxivHtml'
import { buildPdfText, pageFromItems, pdfPageOf, rectsOnPage } from './pdfText'

const enc = (s: string) => new TextEncoder().encode(s)
const PAGE = `<html><head><script>evil()</script></head><body><a href="/abs/2310.06825v1">back</a>
<article class="ltx_document"><div class="ltx_para"><p>One.</p></div><div class="ltx_para"><p>Two.</p></div><div class="ltx_para"><p>Three.</p></div>
<img src="2310.06825v1/x1.png" alt="fig"><img src="https://static.arxiv.org/logo.svg"><img src="data:image/png;base64,AAAA"></article></body></html>`

function memory(): HtmlFiles & { data: Map<string, string | Uint8Array> } {
  const data = new Map<string, string | Uint8Array>()
  return {
    data,
    readText: async (k, n) => (data.get(`${k}/${n}`) as string | undefined) ?? null,
    writeText: async (k, n, t) => void data.set(`${k}/${n}`, t),
    writeBytes: async (k, n, b) => void data.set(`${k}/${n}`, b)
  }
}

describe('arXiv HTML download', () => {
  it('saves the page and its figures, and points the figures at the local copies', async () => {
    const files = memory()
    const asked: string[] = []
    const get = async (url: string) => {
      asked.push(url)
      if (url === 'https://arxiv.org/html/2310.06825v1') return { status: 200, body: enc(PAGE) }
      if (url === 'https://arxiv.org/html/2310.06825v1/x1.png') return { status: 200, body: new Uint8Array([1, 2, 3]), type: 'image/png' }
      return { status: 404, body: new Uint8Array() }
    }
    const r = await ensureArxivHtml('2310.06825', 'v1', { files, get })
    expect(r).toEqual({ ok: true, key: '2310.06825v1', version: 'v1' })
    const html = files.data.get('2310.06825v1/index.html') as string
    expect(html).toContain('src="img/1.png"')
    expect(html).toContain('src="https://static.arxiv.org/logo.svg"')
    expect(files.data.get('2310.06825v1/img/1.png')).toEqual(new Uint8Array([1, 2, 3]))
    expect(asked).not.toContain('https://static.arxiv.org/logo.svg')
    // 第二次直接用存好的
    asked.length = 0
    expect(await ensureArxivHtml('2310.06825', 'v1', { files, get })).toMatchObject({ ok: true })
    expect(asked).toEqual([])
  })

  it('saves SVG figures that arXiv puts in <object> as local images', async () => {
    const svgPage = PAGE.replace('</article>', '<figure><object type="image/svg+xml" data="2310.06825v1/fig.svg" id="S1.F1.g1" class="ltx_graphics" width="476" height="99"></object></figure></article>')
    const files = memory()
    const get = async (url: string) => {
      if (url === 'https://arxiv.org/html/2310.06825v1') return { status: 200, body: enc(svgPage) }
      if (url === 'https://arxiv.org/html/2310.06825v1/fig.svg') return { status: 200, body: enc('<svg/>'), type: 'image/svg+xml' }
      return { status: 404, body: new Uint8Array() }
    }
    await ensureArxivHtml('2310.06825', 'v1', { files, get })
    const html = files.data.get('2310.06825v1/index.html') as string
    expect(html).not.toContain('<object')
    expect(html).toMatch(/<img src="img\/\d\.svg" id="S1\.F1\.g1" class="ltx_graphics" width="476" height="99">/)
    expect(files.data.get('2310.06825v1/img/2.svg') ?? files.data.get('2310.06825v1/img/1.svg')).toEqual(enc('<svg/>'))
  })

  it('downloads an old copy again once when it is missing <object> figures, keeping its version', async () => {
    const files = memory()
    files.data.set('2302.04761/meta.json', JSON.stringify({ ok: true, id: '2302.04761', version: 'v1', images: 0 }))
    files.data.set('2302.04761/index.html', '<object type="image/svg+xml" data="2302.04761v1/a.svg"></object>')
    files.data.set('2310.06825v1/meta.json', JSON.stringify({ ok: true, id: '2310.06825', version: 'v1', images: 1 }))
    files.data.set('2310.06825v1/index.html', '<img src="img/1.png">')
    const asked: string[] = []
    const get = async (url: string) => (asked.push(url), { status: 404, body: new Uint8Array() })
    // 旧的、没有 object 图的照用
    expect(await ensureArxivHtml('2310.06825', 'v1', { files, get })).toEqual({ ok: true, key: '2310.06825v1', version: 'v1' })
    expect(asked).toEqual([])
    // 有 object 图的去下同一版
    // 下载不成（这里 404）就接着用旧的，不当成没有网页版
    expect(await ensureArxivHtml('2302.04761', null, { files, get })).toEqual({ ok: true, key: '2302.04761', version: 'v1' })
    expect(asked).toEqual(['https://arxiv.org/html/2302.04761v1'])
    expect(JSON.parse(files.data.get('2302.04761/meta.json') as string)).toMatchObject({ ok: true })
    const offline = async () => Promise.reject(new Error('offline'))
    expect(await ensureArxivHtml('2302.04761', null, { files, get: offline })).toMatchObject({ ok: true })
  })

  it('remembers papers without an HTML version for a while', async () => {
    const files = memory()
    let n = 0
    const get = async () => (n++, { status: 404, body: new Uint8Array() })
    let now = 0
    expect(await ensureArxivHtml('1412.6980', 'v9', { files, get, now: () => now })).toEqual({ ok: false, reason: 'none' })
    expect(await ensureArxivHtml('1412.6980', 'v9', { files, get, now: () => now })).toEqual({ ok: false, reason: 'none' })
    expect(n).toBe(1)
    now = 8 * 24 * 3600_000
    await ensureArxivHtml('1412.6980', 'v9', { files, get, now: () => now })
    expect(n).toBe(2)
  })

  it('treats a failed conversion as no HTML, and a network error as try again', async () => {
    const files = memory()
    expect(await ensureArxivHtml('2401.00001', null, { files, get: async () => ({ status: 200, body: enc('<html>Untitled Document</html>') }) })).toEqual({ ok: false, reason: 'none' })
    const r = await ensureArxivHtml('2401.00002', null, { files, get: async () => Promise.reject(new Error('offline')) })
    expect(r).toMatchObject({ ok: false, reason: 'offline' })
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
