import { describe, expect, it } from 'vitest'
import { findQuote, mergeRects, quoteAt, squash } from './anchor'

const page = 'We study sparse   mixtures.\nThe model is small. The model is fast and the model is cheap.'

describe('text quote anchors', () => {
  it('squashes whitespace', () => {
    expect(squash('  a \n\t b ')).toBe('a b')
  })

  it('records the quote with context and finds it again', () => {
    const start = page.indexOf('The model is fast')
    const q = quoteAt(page, start, start + 'The model is fast'.length)
    expect(q.exact).toBe('The model is fast')
    expect(q.prefix.endsWith('small.')).toBe(true)
    expect(findQuote(page, q)).toEqual([start, start + q.exact.length])
  })

  it('picks the occurrence whose context matches', () => {
    const second = page.lastIndexOf('the model')
    const q = quoteAt(page, second, second + 9)
    expect(findQuote(page, q)).toEqual([second, second + 9])
  })

  it('matches across different whitespace and returns null when missing', () => {
    const q = { exact: 'sparse mixtures. The model', prefix: 'We study', suffix: 'is small' }
    const r = findQuote(page, q)!
    expect(page.slice(r[0], r[1])).toBe('sparse   mixtures.\nThe model')
    expect(findQuote(page, { exact: 'not here', prefix: '', suffix: '' })).toBeNull()
  })

  it('merges rects on the same line and keeps lines apart', () => {
    const merged = mergeRects([
      [10, 700, 50, 712],
      [50, 700.5, 90, 712],
      [10, 686, 80, 698],
      [5, 5, 5.2, 5.1]
    ])
    expect(merged).toEqual([[10, 700, 90, 712], [10, 686, 80, 698]])
  })
})
