import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { collectHits, findAll, firstHit, flattenText, normalizeQuery, plainNote, searchable, snippetAt, TextIndex } from './search'
import { Library } from './library'
import type { Annotation } from './model'

describe('snippets', () => {
  it('finds every match regardless of case', () => {
    expect(findAll('Attention, attention, ATTENTION', 'attention')).toEqual([0, 11, 22])
    expect(findAll('aaa', 'aa')).toEqual([0])
  })
  it('cuts around the match at word boundaries with ellipses', () => {
    const text = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen'
    const at = text.indexOf('seven')
    const s = snippetAt(text, at, 5, 12, 14)
    expect(s.match).toBe('seven')
    expect(s.before).toBe('…five six ')
    expect(s.after).toBe(' eight nine…')
  })
  it('keeps short texts whole', () => {
    expect(snippetAt('we add positional encodings', 7, 10)).toEqual({ before: 'we add ', match: 'positional', after: ' encodings' })
  })
  it('finds phrases broken across lines and counts them', () => {
    const r = firstHit('we add "positional\nencodings" and positional  encodings', 'positional encodings')!
    expect(r.count).toBe(2)
    expect(r.snippet.match).toBe('positional encodings')
  })
  it('normalizes queries and needs two characters', () => {
    expect(normalizeQuery('  positional \n encoding ')).toBe('positional encoding')
    expect(searchable('a')).toBe(false)
    expect(searchable('注意')).toBe(true)
    expect(flattenText(' a\n\nb ')).toBe('a b')
  })
  it('matches Chinese text stored with radicals and spaces between characters', () => {
    expect(flattenText('注意 ⼒ 机制在 ⾃ 然语 ⾔ 处理中')).toBe('注意力机制在自然语言处理中')
    expect(normalizeQuery('注意 力')).toBe('注意力')
    expect(flattenText('Transformer 的 关键')).toBe('Transformer 的关键')
    expect(flattenText('ﬁne-tuning')).toBe('fine-tuning')
  })
})

describe('plainNote', () => {
  it('drops Markdown marks and link targets', () => {
    const md = '# 读书笔记\n\n> sine and **cosine**\n> [第 6 页](flax://annotation/abc)\n\n- 和 [[Transformer 笔记|Transformer]] 对比 `RoPE`'
    expect(flattenText(plainNote(md))).toBe('读书笔记 sine and cosine 第 6 页和 Transformer 笔记对比 RoPE')
  })
})

describe('TextIndex', () => {
  const index = () => new TextIndex(new DatabaseSync(':memory:'))
  it('finds pages by English and Chinese fragments, ignoring case', () => {
    const ix = index()
    ix.put('h1', ['Introduction', 'We add Positional\nEncodings to the input.', '注意力机制的计算'])
    expect(ix.has('h1')).toBe(true)
    expect(ix.search('positional encodings').map((r) => r.page)).toEqual([2])
    expect(ix.search('注意力').map((r) => r.page)).toEqual([3])
    // 两个字走不了 trigram 索引，照样能找到
    expect(ix.search('机制').map((r) => r.page)).toEqual([3])
    expect(ix.search('nothing here')).toEqual([])
  })
  it('treats % and _ as plain characters', () => {
    const ix = index()
    ix.put('h1', ['accuracy 95% on the test set', 'snake_case names'])
    expect(ix.search('95%').map((r) => r.page)).toEqual([1])
    expect(ix.search('e_c').map((r) => r.page)).toEqual([2])
    expect(ix.search('5%o')).toEqual([])
  })
  it('replaces a file and remembers files without text', () => {
    const ix = index()
    ix.put('h1', ['old words'])
    ix.put('h1', ['new words'])
    expect(ix.search('old')).toEqual([])
    ix.put('scan', ['', ''])
    expect(ix.has('scan')).toBe(true)
  })
  it('starts over when the index was written by an older version', () => {
    const db = new DatabaseSync(':memory:')
    new TextIndex(db).put('h1', ['alpha'])
    db.exec('PRAGMA user_version = 0')
    const ix = new TextIndex(db)
    expect(ix.has('h1')).toBe(false)
    expect(ix.search('alpha')).toEqual([])
  })
  it('prunes files no paper uses any more', () => {
    const ix = index()
    ix.put('keep', ['alpha beta'])
    ix.put('gone', ['alpha gamma'])
    ix.prune(new Set(['keep']))
    expect(ix.has('gone')).toBe(false)
    expect(ix.search('alpha').map((r) => r.hash)).toEqual(['keep'])
  })
})

describe('collectHits', () => {
  const anno = (over: Partial<Annotation>): Annotation =>
    ({ id: 'a1', paperId: 'p1', fileHash: 'h1', type: 'highlight', origin: 'select', color: 'yellow', page: 5, target: { rects: [[0, 0, 1, 1]] as [number, number, number, number][], quote: { exact: 'sine and cosine functions', prefix: '', suffix: '' } }, comment: 'why not learned position embeddings?', createdAt: '', updatedAt: '', deviceId: 'd', ...over }) as Annotation
  it('groups page and annotation hits by paper, sorted by page with annotations first', () => {
    const hits = collectHits({
      query: 'position',
      files: [{ paperId: 'p1', hash: 'h1' }, { paperId: 'p2', hash: 'h2' }],
      pages: [
        { hash: 'h1', page: 6, text: 'we add positional encodings. Position matters.' },
        { hash: 'h1', page: 2, text: 'no match here' },
        { hash: 'h2', page: 4, text: 'learnable 1D position embeddings' }
      ],
      annotations: [anno({})]
    })
    const p1 = hits.find((h) => h.paperId === 'p1')!
    expect(p1.hits.map((h) => [h.kind, h.page])).toEqual([['anno', 6], ['page', 6]])
    expect(p1.total).toBe(3)
    expect(p1.hits[0]).toMatchObject({ kind: 'anno', id: 'a1', color: 'yellow', match: 'position' })
    expect(hits.find((h) => h.paperId === 'p2')!.total).toBe(1)
  })
  it('skips annotations that only matched inside JSON', () => {
    expect(collectHits({ query: 'yellow', files: [], pages: [], annotations: [anno({})] })).toEqual([])
  })
})

describe('Library.searchAnnotations', () => {
  it('finds annotations by quote or comment, not deleted ones', () => {
    const lib = new Library(new DatabaseSync(':memory:'))
    const p = lib.addPaper({ title: 'Attention Is All You Need', authors: [], identifiers: {}, source: 'user' }, { file: { hash: 'h1', size: 1, role: 'main', fileName: 'a.pdf' } as never })
    const base = { paperId: p.id, fileHash: 'h1', type: 'highlight' as const, origin: 'select' as const, color: 'yellow' as const, page: 0, target: { rects: [[0, 0, 1, 1]] as [number, number, number, number][], quote: { exact: 'multi-head attention', prefix: '', suffix: '' } } }
    const a = lib.addAnnotation({ ...base })
    const b = lib.addAnnotation({ ...base, target: { rects: [[0, 0, 1, 1]] as [number, number, number, number][], quote: { exact: 'layer norm', prefix: '', suffix: '' } }, comment: '和 Attention 有关' })
    lib.addAnnotation({ ...base, target: { rects: [[0, 0, 1, 1]] as [number, number, number, number][], quote: { exact: 'unrelated', prefix: '', suffix: '' } } })
    expect(lib.searchAnnotations('attention').map((x) => x.id).sort()).toEqual([a.id, b.id].sort())
    lib.removeAnnotation(a.id)
    expect(lib.searchAnnotations('attention').map((x) => x.id)).toEqual([b.id])
  })
})
