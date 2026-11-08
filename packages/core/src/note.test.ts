import { describe, expect, test } from 'vitest'
import { extractAnnotationRefs, extractLinks, noteExcerpt, parseNote, quoteBlock, safeNoteTitle, serializeNote } from './note'

describe('front matter', () => {
  test('round trip keeps unknown lines', () => {
    const text = '---\nid: n1\npaper: p1\ncreated: 2026-11-06T00:00:00.000Z\ntags: [a, b]\n---\n# Hi\n'
    const n = parseNote(text)
    expect(n.head).toEqual({ id: 'n1', paperId: 'p1', createdAt: '2026-11-06T00:00:00.000Z' })
    expect(n.body).toBe('# Hi\n')
    expect(n.extra).toEqual(['tags: [a, b]'])
    expect(serializeNote(n.head as never, n.body, n.extra)).toBe(text)
  })
  test('file without front matter is all body', () => {
    expect(parseNote('just text')).toEqual({ head: {}, body: 'just text', extra: [] })
  })
  test('standalone note has no paper line', () => {
    expect(serializeNote({ id: 'x', createdAt: 't' }, 'b')).toBe('---\nid: x\ncreated: t\n---\nb')
  })
})

describe('titles and links', () => {
  test('unsafe characters become spaces', () => {
    expect(safeNoteTitle('a/b: c?')).toBe('a b c')
    expect(safeNoteTitle('[[x]]')).toBe('x')
    expect(safeNoteTitle('  ')).toBe('未命名笔记')
    expect(safeNoteTitle('..hidden')).toBe('hidden')
  })
  test('wiki links ignore alias, heading and embeds', () => {
    expect(extractLinks('see [[注意力机制]] and [[Transformer|它]] and [[A#方法]] and ![[img.png]] and [[注意力机制]]')).toEqual(['注意力机制', 'Transformer', 'A'])
  })
  test('annotation refs', () => {
    const id = '1c7b899a-b114-4a2e-82c0-0f2dccebdd4c'
    expect(extractAnnotationRefs(`> x\n> [第 3 页](flax://annotation/${id})`)).toEqual([id])
    // 改名前写的链接也认
    expect(extractAnnotationRefs(`> x\n> [第 3 页](paper://annotation/${id})`)).toEqual([id])
  })
})

test('excerpt skips headings and quotes', () => {
  expect(noteExcerpt('# Title\n\n> quoted\n\nThe [[main|key]] idea is **simple**.')).toBe('The key idea is simple.')
  expect(noteExcerpt('- [ ] 买 ~~牛奶~~')).toBe('买 牛奶')
})

test('quote block links back to the annotation', () => {
  expect(quoteBlock('a   b\nc', 3, 'id1', '我的看法')).toBe('> a b c\n> [第 3 页](flax://annotation/id1)\n\n我的看法')
})
