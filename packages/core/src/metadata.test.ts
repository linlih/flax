import { describe, expect, it } from 'vitest'
import { findIdentifiers, guessFromPdf, identifyPdf, identifyText, parseArxivFeed, parseOpenLibrary, parseCrossrefWork, searchByTitle, splitName, type FetchText, type PdfFacts } from './metadata'

// 测试用的响应都是自己编的，只模仿 arXiv Atom 和 Crossref JSON 的结构
const ARXIV_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2101.01234v3</id>
    <published>2021-01-05T10:00:00Z</published>
    <title>Sparse Mixtures for
      Long Documents &amp; Beyond</title>
    <summary>  We study a small idea.
    It works.  </summary>
    <author><name>Ada Lovelace</name></author>
    <author><name>Alan M. Turing</name></author>
    <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.9999/ABC.1</arxiv:doi>
    <arxiv:journal_ref xmlns:arxiv="http://arxiv.org/schemas/atom">Journal of Examples 3 (2022)</arxiv:journal_ref>
  </entry>
</feed>`

const ARXIV_ERROR = `<feed><entry><id>http://arxiv.org/api/errors#incorrect_id_format</id><title>Error</title></entry></feed>`

const CROSSREF = {
  DOI: '10.9999/XYZ.2',
  title: ['Graph Methods  for Tables'],
  author: [{ given: 'Grace', family: 'Hopper' }, { name: 'Example Consortium' }],
  issued: { 'date-parts': [[2019, 4]] },
  'container-title': ['Proceedings of Example'],
  abstract: '<jats:p>Tables are graphs.</jats:p>'
}

const facts = (over: Partial<PdfFacts> = {}): PdfFacts => ({ fileName: 'x.pdf', info: {}, text: '', lines: [], pageCount: 10, ...over })

function fakeFetch(routes: Record<string, { status: number; body: string } | 'offline'>): FetchText & { calls: string[] } {
  const calls: string[] = []
  const f = (async (url: string) => {
    calls.push(url)
    const key = Object.keys(routes).find((k) => url.includes(k))
    const r = key ? routes[key] : { status: 404, body: '' }
    if (r === 'offline') throw new Error('network')
    return r!
  }) as FetchText & { calls: string[] }
  f.calls = calls
  return f
}

describe('parsers', () => {
  it('parses an arXiv entry', () => {
    const [m] = parseArxivFeed(ARXIV_FEED)
    expect(m).toEqual({
      title: 'Sparse Mixtures for Long Documents & Beyond',
      authors: [{ given: 'Ada', family: 'Lovelace' }, { given: 'Alan M.', family: 'Turing' }],
      year: 2021,
      venue: 'Journal of Examples 3 (2022)',
      abstract: 'We study a small idea. It works.',
      identifiers: { arxiv: '2101.01234', doi: '10.9999/abc.1' },
      source: 'arxiv'
    })
  })
  it('ignores the arXiv error entry', () => {
    expect(parseArxivFeed(ARXIV_ERROR)).toEqual([])
  })
  it('parses a Crossref work', () => {
    expect(parseCrossrefWork(CROSSREF)).toEqual({
      title: 'Graph Methods for Tables',
      authors: [{ given: 'Grace', family: 'Hopper' }, { family: 'Example Consortium' }],
      year: 2019,
      venue: 'Proceedings of Example',
      abstract: 'Tables are graphs.',
      identifiers: { doi: '10.9999/xyz.2' },
      source: 'crossref'
    })
  })
  it('splits names both ways', () => {
    expect(splitName('Lovelace, Ada')).toEqual({ given: 'Ada', family: 'Lovelace' })
    expect(splitName('Plato')).toEqual({ family: 'Plato' })
  })
})

describe('findIdentifiers', () => {
  it('prefers the arXiv margin stamp over other ids in the text', () => {
    const text = 'Related work 1912.01234 ... arXiv:2101.01234v2 [cs.LG] 5 Jan 2021 doi 10.9999/other'
    expect(findIdentifiers({ fileName: 'paper.pdf', info: {}, text })).toEqual({ arxiv: '2101.01234', doi: '10.9999/other' })
  })
  it('treats an arXiv DOI as an arXiv id', () => {
    expect(findIdentifiers({ fileName: 'a.pdf', info: {}, text: 'https://doi.org/10.48550/arXiv.2101.01234' })).toEqual({ arxiv: '2101.01234' })
  })
  it('reads the id from the file name', () => {
    expect(findIdentifiers({ fileName: '2101.01234v1.pdf', info: {}, text: '' })).toEqual({ arxiv: '2101.01234' })
  })
})

describe('identifyPdf', () => {
  it('uses arXiv first when there is an arXiv id', async () => {
    const f = fakeFetch({ 'export.arxiv.org': { status: 200, body: ARXIV_FEED }, 'api.crossref.org': { status: 200, body: JSON.stringify({ message: CROSSREF }) } })
    const r = await identifyPdf(facts({ text: 'arXiv:2101.01234v3 [cs.CL] 1 Jan 2021 and 10.9999/xyz.2' }), f)
    expect(r.needsMatch).toBe(false)
    expect(r.meta.source).toBe('arxiv')
    expect(f.calls).toHaveLength(1)
  })
  it('falls back to Crossref when arXiv has nothing', async () => {
    const f = fakeFetch({ 'export.arxiv.org': { status: 200, body: ARXIV_ERROR }, 'api.crossref.org': { status: 200, body: JSON.stringify({ message: CROSSREF }) } })
    const r = await identifyPdf(facts({ text: 'arXiv:2101.01234 [cs.CL] doi:10.9999/xyz.2' }), f)
    expect(r.meta.source).toBe('crossref')
  })
  it('keeps the ids and flags lookup_failed when offline', async () => {
    const r = await identifyPdf(facts({ fileName: 'Some Paper.pdf', text: 'doi:10.9999/xyz.2' }), fakeFetch({ 'api.crossref.org': 'offline' }))
    expect(r).toMatchObject({ needsMatch: true, matchIssue: 'lookup_failed', meta: { identifiers: { doi: '10.9999/xyz.2' } } })
  })
  it('guesses from the PDF and flags no_id without any id', async () => {
    const f = fakeFetch({})
    const r = await identifyPdf(facts({ info: { title: 'Microsoft Word - draft.docx' }, lines: [
      { text: 'Workshop on Examples', size: 9, y: 760 },
      { text: 'Learning to Sort Socks', size: 17, y: 720 },
      { text: 'with Very Small Robots', size: 17, y: 700 },
      { text: 'Grace Hopper', size: 11, y: 670 }
    ] }), f)
    expect(r).toMatchObject({ needsMatch: true, matchIssue: 'no_id', meta: { title: 'Learning to Sort Socks with Very Small Robots', source: 'pdf' } })
    expect(f.calls).toHaveLength(0)
  })
})

describe('guessFromPdf', () => {
  it('uses a plausible PDF title and authors', () => {
    expect(guessFromPdf(facts({ info: { title: 'Learning to Sort Socks', author: 'Grace Hopper; Ada Lovelace' } }))).toMatchObject({
      title: 'Learning to Sort Socks',
      authors: [{ given: 'Grace', family: 'Hopper' }, { given: 'Ada', family: 'Lovelace' }]
    })
  })
  it('falls back to the file name', () => {
    expect(guessFromPdf(facts({ fileName: 'scan_lecture_notes.pdf' }))).toMatchObject({ title: 'scan lecture notes', source: 'filename' })
  })
})

describe('identifyText', () => {
  it('looks up a pasted arXiv link', async () => {
    const r = await identifyText('https://arxiv.org/abs/2101.01234', fakeFetch({ 'export.arxiv.org': { status: 200, body: ARXIV_FEED } }))
    expect(r?.meta.title).toContain('Sparse Mixtures')
  })
  it('returns null for text without an id', async () => {
    expect(await identifyText('hello world', fakeFetch({}))).toBeNull()
  })
})

// 编的 Open Library 响应，只模仿结构
const BOOK = { 'ISBN:9780306406157': { title: 'A Field Guide to Examples', subtitle: 'Second Edition', authors: [{ name: 'Grace Hopper' }], publishers: [{ name: 'Example Press' }], publish_date: '3 January 2017' } }

describe('books', () => {
  it('reads title, authors, publisher and year from Open Library', () => {
    expect(parseOpenLibrary(BOOK, '9780306406157')).toEqual({
      title: 'A Field Guide to Examples: Second Edition',
      authors: [{ given: 'Grace', family: 'Hopper' }],
      identifiers: { isbn: '9780306406157' },
      year: 2017,
      venue: 'Example Press',
      source: 'openlibrary'
    })
    expect(parseOpenLibrary({}, '9780306406157')).toBeNull()
  })
  it('looks a book up by the ISBN found in the PDF', async () => {
    const r = await identifyPdf(facts({ isbn: '9780306406157', pageCount: 300 }), fakeFetch({ 'openlibrary.org': { status: 200, body: JSON.stringify(BOOK) } }))
    expect(r).toMatchObject({ needsMatch: false, meta: { title: 'A Field Guide to Examples: Second Edition', identifiers: { isbn: '9780306406157' } } })
  })
  it('keeps what the PDF says, and the ISBN, when the book is not in Open Library', async () => {
    const r = await identifyPdf(facts({ isbn: '9780306406157', info: { title: '深度学习', author: '张三、李四' } }), fakeFetch({ 'openlibrary.org': { status: 200, body: '{}' } }))
    expect(r).toMatchObject({ needsMatch: true, matchIssue: 'not_found', meta: { title: '深度学习', authors: [{ family: '张三' }, { family: '李四' }], identifiers: { isbn: '9780306406157' } } })
  })
  it('ignores the ISBN when the PDF has a DOI: a paper in proceedings prints the ISBN of the whole volume', () => {
    expect(findIdentifiers({ fileName: 'p.pdf', info: {}, text: 'doi 10.9999/xyz.2', isbn: '9780306406157' })).toEqual({ doi: '10.9999/xyz.2' })
  })
  it('takes a pasted ISBN', async () => {
    const r = await identifyText('978-0-306-40615-7', fakeFetch({ 'openlibrary.org': { status: 200, body: JSON.stringify(BOOK) } }))
    expect(r?.meta.venue).toBe('Example Press')
  })
})

describe('searchByTitle', () => {
  it('ranks candidates by title similarity', async () => {
    const other = { ...CROSSREF, title: ['Something Unrelated Entirely'] }
    const f = fakeFetch({
      'api.crossref.org': { status: 200, body: JSON.stringify({ message: { items: [other, CROSSREF] } }) },
      'export.arxiv.org': { status: 200, body: '<feed></feed>' }
    })
    const r = await searchByTitle('Graph methods for tables', f)
    expect(r[0]?.title).toBe('Graph Methods for Tables')
    expect(r[0]!.similarity).toBeGreaterThan(0.95)
    expect(r[1]!.similarity).toBeLessThan(0.5)
  })
  it('throws when every source is offline', async () => {
    await expect(searchByTitle('Graph methods for tables', fakeFetch({ 'api.crossref.org': 'offline', 'export.arxiv.org': 'offline' }))).rejects.toThrow()
  })
})
