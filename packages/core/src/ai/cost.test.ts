import { expect, test } from 'vitest'
import { citeMarker, costOf, extractJson, joinPages, pageOfOffset, parseKeyPoints, splitCitations, stripCitations } from './cost'

test('citations split out of the answer and number repeats once', () => {
  const s = `方法很简单${citeMarker(3, 'We keep  both.')}，效果更好${citeMarker(5, 'Results show')}，见上${citeMarker(3, 'We keep both.')}。`
  const segs = splitCitations(s)
  expect(segs.filter((x) => x.kind === 'cite').map((x) => x.kind === 'cite' && [x.page, x.quote, x.n])).toEqual([[3, 'We keep both.', 1], [5, 'Results show', 2], [3, 'We keep both.', 1]])
  expect(stripCitations(s)).toBe('方法很简单，效果更好，见上。')
})

test('a half-written marker at the end of a stream is hidden', () => {
  expect(splitCitations('结论成立⟦4|Quotes wi')).toEqual([{ kind: 'text', text: '结论成立' }])
})

test('marker text cannot break the format', () => {
  expect(citeMarker(2, 'a | b ⟧ c')).toBe('⟦2|a b c⟧')
})

test('offsets map back to pages', () => {
  const { text, starts } = joinPages(['aaa', 'bb', 'c'])
  expect(text).toBe('aaa\n\nbb\n\nc')
  expect([0, 2, 3, 5, 6, 9].map((i) => pageOfOffset(starts, i))).toEqual([1, 1, 1, 2, 2, 3])
})

test('cost uses cache prices for known models only', () => {
  expect(costOf('claude-opus-5-5', { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 0 })).toBeCloseTo(24.2)
  expect(costOf('deepseek-chat', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull()
})

test('key points are read out of fenced JSON and cleaned', () => {
  const raw = extractJson('好的：\n```json\n{"oneLiner":" 一句话 ","readingGuide":{"estimatedMinutes":"20","steps":[{"title":"看图 1","why":"核心","kind":"weird","pages":[2,2,99,"3"]},{"title":""}]},"findings":["a",""," b"]}\n```')
  expect(parseKeyPoints(raw, 6)).toEqual({
    oneLiner: '一句话',
    readingGuide: { estimatedMinutes: 20, steps: [{ title: '看图 1', why: '核心', kind: 'core', pages: [2, 3] }] },
    problem: '',
    method: '',
    datasets: [],
    findings: ['a', 'b'],
    limitations: []
  })
  expect(() => parseKeyPoints({}, 3)).toThrow()
})
