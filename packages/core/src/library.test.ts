import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { Library } from './library'
import type { FileRef, PaperMeta } from './model'

let lib: Library
let tick = 0
let seq = 0

const meta = (over: Partial<PaperMeta> = {}): PaperMeta => ({
  title: 'A Study of Sparse Mixtures for Long Documents',
  authors: [{ given: 'Ada', family: 'Lovelace' }],
  year: 2021,
  identifiers: { arxiv: '2101.01234' },
  source: 'arxiv',
  ...over
})
const file = (hash: string): FileRef => ({ hash, size: 100, mime: 'application/pdf', role: 'main', addedAt: 'x' })

beforeEach(() => {
  tick = 0
  seq = 0
  lib = new Library(new DatabaseSync(':memory:'), {
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
    uuid: () => `id-${++seq}`
  })
})

describe('Library papers', () => {
  it('marks bulk imports so they do not show as new', () => {
    const one = lib.addPaper(meta())
    const many = lib.addPaper(meta({ title: 'From Zotero', identifiers: {} }), { batch: true })
    expect(one.readingStatus).toBe('inbox')
    expect(one.batch).toBeUndefined()
    expect(lib.getPaper(many.id)?.batch).toBe(true)
  })

  it('adds and lists papers, newest first, with sync fields', () => {
    const a = lib.addPaper(meta(), { file: file('h1') })
    const b = lib.addPaper(meta({ title: 'Another One About Retrieval', identifiers: {} }))
    expect(lib.listPapers().map((p) => p.id)).toEqual([b.id, a.id])
    expect(a.deviceId).toBe(lib.deviceId)
    expect(a.updatedAt).toBeTruthy()
    expect(a.readingStatus).toBe('inbox')
  })

  it('keeps the same device id when reopened', () => {
    const db = new DatabaseSync(':memory:')
    const one = new Library(db)
    const two = new Library(db)
    expect(two.deviceId).toBe(one.deviceId)
  })

  it('finds duplicates by file hash, DOI, arXiv id and long titles', () => {
    const p = lib.addPaper(meta({ identifiers: { arxiv: '2101.01234', doi: '10.1/abc' } }), { file: file('h1') })
    expect(lib.findDuplicate({ hash: 'h1' })).toMatchObject({ reason: 'file', paper: { id: p.id } })
    expect(lib.findDuplicate({ doi: '10.1/ABC' })).toMatchObject({ reason: 'doi' })
    expect(lib.findDuplicate({ arxiv: '2101.01234' })).toMatchObject({ reason: 'arxiv' })
    expect(lib.findDuplicate({ title: 'a study of sparse mixtures, for long documents!' })).toMatchObject({ reason: 'title' })
    expect(lib.findDuplicate({ title: 'Introduction' })).toBeNull()
    expect(lib.findDuplicate({ hash: 'h1' }, p.id)).toBeNull()
  })

  it('does not report removed papers as duplicates, and can restore them', () => {
    const p = lib.addPaper(meta(), { file: file('h1') })
    lib.removePaper(p.id)
    expect(lib.listPapers()).toHaveLength(0)
    expect(lib.findDuplicate({ hash: 'h1' })).toBeNull()
    lib.restorePaper(p.id)
    expect(lib.listPapers()).toHaveLength(1)
  })

  it('applies looked-up metadata and clears the match flag', () => {
    const p = lib.addPaper(meta({ title: 'scan.pdf', authors: [], identifiers: {}, source: 'filename' }), { needsMatch: true, matchIssue: 'no_id' })
    const q = lib.applyMeta(p.id, meta({ identifiers: { doi: '10.1/x' }, source: 'crossref' }), { needsMatch: false })
    expect(q).toMatchObject({ needsMatch: false, metadataSource: 'crossref', identifiers: { doi: '10.1/x' } })
    expect(q.matchIssue).toBeUndefined()
    expect(lib.findDuplicate({ doi: '10.1/x' })?.paper.id).toBe(p.id)
  })

  it('marks manual metadata edits as user-sourced and bumps updatedAt', () => {
    const p = lib.addPaper(meta(), { needsMatch: true, matchIssue: 'not_found' })
    const q = lib.updatePaper(p.id, { title: 'Corrected Title', year: undefined })
    expect(q).toMatchObject({ title: 'Corrected Title', metadataSource: 'user', needsMatch: false })
    expect(q.year).toBeUndefined()
    expect(q.updatedAt > p.updatedAt).toBe(true)
    const r = lib.updatePaper(p.id, { readingStatus: 'reading' })
    expect(r.metadataSource).toBe('user')
    expect(r.readingStatus).toBe('reading')
  })

  it('adds another file version to an existing paper', () => {
    const p = lib.addPaper(meta(), { file: file('h1') })
    lib.addFile(p.id, { ...file('h2'), role: 'preprint' })
    expect(lib.getPaper(p.id)?.files.map((f) => f.hash)).toEqual(['h1', 'h2'])
    expect(lib.findDuplicate({ hash: 'h2' })?.paper.id).toBe(p.id)
  })
})

describe('Library folders and tags', () => {
  it('creates, renames and removes folders without touching papers', () => {
    const f = lib.createFolder(' 扩散模型 ')
    const g = lib.createFolder('推理')
    expect(lib.listFolders().map((x) => x.name)).toEqual(['扩散模型', '推理'])
    const p = lib.addPaper(meta())
    lib.updatePaper(p.id, { folderIds: [f.id, g.id, f.id] })
    expect(lib.getPaper(p.id)?.folderIds).toEqual([f.id, g.id])
    lib.renameFolder(f.id, '生成模型')
    expect(lib.listFolders()[0]?.name).toBe('生成模型')
    lib.removeFolder(f.id)
    expect(lib.listFolders().map((x) => x.id)).toEqual([g.id])
    expect(lib.getPaper(p.id)?.folderIds).toEqual([g.id])
    expect(() => lib.createFolder('  ')).toThrow()
  })

  it('cleans, counts, renames and merges tags', () => {
    const a = lib.addPaper(meta())
    const b = lib.addPaper(meta({ title: 'Second Paper About Something Else', identifiers: {} }))
    lib.updatePaper(a.id, { tags: [' #llm', 'llm', 'rag', ''] })
    lib.updatePaper(b.id, { tags: ['LLM', 'rag'] })
    expect(lib.getPaper(a.id)?.tags).toEqual(['llm', 'rag'])
    expect(lib.listTags()).toEqual([{ tag: 'rag', count: 2 }, { tag: 'llm', count: 1 }, { tag: 'LLM', count: 1 }])
    expect(lib.renameTag('LLM', 'llm')).toBe(1)
    expect(lib.listTags()).toEqual([{ tag: 'llm', count: 2 }, { tag: 'rag', count: 2 }])
  })

  it('keeps one color per tag and carries it through a rename', () => {
    const a = lib.addPaper(meta({ identifiers: {} }))
    lib.updatePaper(a.id, { tags: ['nlp', 'rag'] })
    lib.setTagColor('nlp', 'blue')
    lib.setTagColor('rag', 'red')
    expect(lib.listTags()).toEqual([{ tag: 'nlp', count: 1, color: 'blue' }, { tag: 'rag', count: 1, color: 'red' }])
    lib.renameTag('nlp', 'NLP')
    expect(lib.tagColors()).toEqual({ NLP: 'blue', rag: 'red' })
    // 合并进已有的标签：用那个标签自己的颜色
    lib.renameTag('NLP', 'rag')
    expect(lib.tagColors()).toEqual({ rag: 'red' })
    lib.setTagColor('rag', null)
    expect(lib.listTags()).toEqual([{ tag: 'rag', count: 1 }])
  })
})

describe('annotations', () => {
  const hl = (paperId: string, page: number, top: number) => ({
    paperId,
    fileHash: 'h1',
    type: 'highlight' as const,
    origin: 'select' as const,
    color: 'yellow' as const,
    page,
    target: { rects: [[10, top - 12, 90, top] as [number, number, number, number]], quote: { exact: 'x', prefix: '', suffix: '' } }
  })

  it('keeps a comment-only note and turns it into a highlight when given a color', () => {
    const p = lib.addPaper(meta())
    const n = lib.addAnnotation({ ...hl(p.id, 0, 300), type: 'note' })
    expect(lib.updateAnnotation(n.id, { comment: '为什么用两种' })).toMatchObject({ type: 'note', comment: '为什么用两种' })
    expect(lib.updateAnnotation(n.id, { color: 'blue', type: 'highlight' })).toMatchObject({ type: 'highlight', color: 'blue', comment: '为什么用两种' })
  })

  it('adds, orders, edits, removes and restores annotations', () => {
    const p = lib.addPaper(meta())
    const b = lib.addAnnotation(hl(p.id, 1, 500))
    const a = lib.addAnnotation(hl(p.id, 0, 300))
    const c = lib.addAnnotation(hl(p.id, 1, 700))
    expect(lib.listAnnotations(p.id).map((x) => x.id)).toEqual([a.id, c.id, b.id])
    expect(a).toMatchObject({ deviceId: lib.deviceId, createdAt: expect.any(String) })

    const e = lib.updateAnnotation(a.id, { color: 'green', comment: 'key idea' })
    expect(e).toMatchObject({ color: 'green', comment: 'key idea' })
    expect(lib.updateAnnotation(a.id, { comment: '  ' }).comment).toBeUndefined()

    lib.removeAnnotation(b.id)
    expect(lib.listAnnotations(p.id)).toHaveLength(2)
    expect(lib.annotationCounts()).toEqual({ [p.id]: 2 })
    lib.restoreAnnotation(b.id)
    expect(lib.listAnnotations(p.id)).toHaveLength(3)
  })

  it('keeps the reading position on the paper', () => {
    const p = lib.addPaper(meta())
    const pos = { fileHash: 'h1', page: 4, left: 0, top: 612, scale: 'page-width', updatedAt: 't' }
    expect(lib.updatePaper(p.id, { readingPosition: pos }).readingPosition).toEqual(pos)
  })

  it('upgrades a version 1 database without losing papers', () => {
    const db = new DatabaseSync(':memory:')
    const old = new Library(db)
    const p = old.addPaper(meta())
    db.exec('DROP TABLE annotations; PRAGMA user_version = 1')
    const again = new Library(db)
    expect(again.getPaper(p.id)?.title).toBe(p.title)
    expect(again.addAnnotation(hl(p.id, 0, 100)).paperId).toBe(p.id)
  })
})

describe('glossary', () => {
  it('adds, updates the same term case-insensitively, edits and soft-deletes', () => {
    const t = lib.addTerm({ term: ' Attention  head ', translation: '注意力头' })
    expect(t.term).toBe('Attention head')
    const again = lib.addTerm({ term: 'attention head', translation: '注意头' })
    expect(again.id).toBe(t.id)
    expect(lib.listTerms().map((x) => x.translation)).toEqual(['注意头'])
    lib.addTerm({ term: 'Transformer', translation: 'Transformer', note: '不译' })
    expect(lib.listTerms().map((x) => x.term)).toEqual(['Attention head', 'Transformer'])
    lib.updateTerm(t.id, { note: '多头注意力里的一个头' })
    lib.removeTerm(t.id)
    expect(lib.listTerms()).toHaveLength(1)
    lib.restoreTerm(t.id)
    expect(lib.listTerms()[0]!.note).toBe('多头注意力里的一个头')
    expect(() => lib.addTerm({ term: 'x', translation: ' ' })).toThrow()
  })

  it('finds terms used in a passage by whole word, plural, hyphen or line break', () => {
    lib.addTerm({ term: 'attention head', translation: '注意力头' })
    lib.addTerm({ term: 'head', translation: '头' })
    lib.addTerm({ term: 'self-attention', translation: '自注意力' })
    lib.addTerm({ term: '残差', translation: 'residual' })
    const found = (s: string) => lib.termsIn(s).map((t) => t.term).sort()
    expect(found('Each of the attention heads uses self\nattention.')).toEqual(['attention head', 'head', 'self-attention'])
    expect(found('The headline result')).toEqual([])
    expect(found('Self-atten-\ntion and one head')).toEqual(['head', 'self-attention'])
    expect(found('加上残差连接')).toEqual(['残差'])
  })
})
