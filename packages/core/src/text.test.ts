import { describe, expect, it } from 'vitest'
import { normalizeTitle, shortAuthors, suggestFileName, titleSimilarity } from './text'

describe('titles', () => {
  it('normalizes case, accents and punctuation', () => {
    expect(normalizeTitle('  Équivariant   Nets: A Survey! ')).toBe('equivariant nets a survey')
    expect(normalizeTitle('多头注意力：综述')).toBe('多头注意力 综述')
  })
  it('scores near-identical titles high and different ones low', () => {
    expect(titleSimilarity('Graph Methods for Tables', 'Graph methods for tables.')).toBe(1)
    expect(titleSimilarity('Graph Methods for Tables', 'Graph Method for Table')).toBeGreaterThan(0.85)
    expect(titleSimilarity('Graph Methods for Tables', 'Sorting socks with robots')).toBeLessThan(0.3)
  })
})

describe('names', () => {
  it('shortens author lists', () => {
    expect(shortAuthors([])).toBe('')
    expect(shortAuthors([{ family: 'Hopper' }])).toBe('Hopper')
    expect(shortAuthors([{ family: 'Hopper' }, { family: 'Lovelace' }])).toBe('Hopper 和 Lovelace')
    expect(shortAuthors([{ family: 'Hopper' }, { family: 'Lovelace' }, { family: 'Turing' }])).toBe('Hopper 等')
  })
  it('builds a readable file name', () => {
    expect(suggestFileName({ title: 'Learning to Sort: Socks/Fast', authors: [{ family: 'Gödel' }], year: 2020 })).toBe('Gödel 2020 - Learning to Sort Socks Fast.pdf')
    expect(suggestFileName({ title: 'Untimed', authors: [] })).toBe('Untimed.pdf')
    expect(suggestFileName({ title: '', authors: [] })).toBe('未命名论文.pdf')
  })
})
