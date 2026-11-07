import { describe, expect, it } from 'vitest'
import { extractArxivId, extractDoi } from './ids'

describe('extractArxivId', () => {
  it('finds a new-style id with version in a PDF header', () => {
    expect(extractArxivId('arXiv:1706.03762v7 [cs.CL] 2 Aug 2023')).toEqual({ id: '1706.03762', version: 'v7' })
  })
  it('finds an id in a file name', () => {
    expect(extractArxivId('2312.00752.pdf')).toEqual({ id: '2312.00752' })
  })
  it('finds an id in an abs URL', () => {
    expect(extractArxivId('https://arxiv.org/abs/2106.09685')).toEqual({ id: '2106.09685' })
  })
  it('rejects numbers that only look like ids', () => {
    expect(extractArxivId('Table 1312.5 shows')).toBeNull()
    expect(extractArxivId('page 2013.12345')).toBeNull() // month 13
  })
  it('finds an old-style id only when arXiv is mentioned', () => {
    expect(extractArxivId('arXiv:hep-th/9901001v2')).toEqual({ id: 'hep-th/9901001', version: 'v2' })
    expect(extractArxivId('see hep-th/9901001')).toBeNull()
  })
})

describe('extractDoi', () => {
  it('finds a DOI and lowercases it', () => {
    expect(extractDoi('https://doi.org/10.1145/3292500.3330701')).toBe('10.1145/3292500.3330701')
    expect(extractDoi('DOI: 10.1038/NATURE14539')).toBe('10.1038/nature14539')
  })
  it('drops trailing punctuation', () => {
    expect(extractDoi('available at 10.1000/xyz123.')).toBe('10.1000/xyz123')
    expect(extractDoi('(doi:10.1000/abc)')).toBe('10.1000/abc')
  })
  it('keeps balanced parentheses inside the DOI', () => {
    expect(extractDoi('10.1002/(SICI)1097-4636(199706)35:4')).toBe('10.1002/(sici)1097-4636(199706)35:4')
  })
  it('returns null without a DOI', () => {
    expect(extractDoi('no identifier here')).toBeNull()
  })
})
