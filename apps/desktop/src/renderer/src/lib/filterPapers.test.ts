// 性能预算（docs/05-体验原则.md）：1 万篇规模的文献库里搜索 ≤ 100ms
import { describe, expect, it } from 'vitest'
import type { Paper } from '@flax/core'
import { filterPapers } from './filterPapers'

const WORDS = ['attention', 'graph', 'neural', 'retrieval', 'diffusion', 'protein', 'language', 'vision', 'robust', 'sparse', 'learning', 'transformer', '学习', '检索']
function fake(i: number): Paper {
  const w = (k: number) => WORDS[(i * 7 + k * 13) % WORDS.length]!
  return {
    id: `p${i}`, title: `${w(1)} ${w(2)} for ${w(3)} ${w(4)} number ${i}`, authors: [{ given: 'Ada', family: `Lovelace${i % 500}` }, { given: 'Alan', family: 'Turing' }],
    year: 1990 + (i % 35), venue: i % 3 ? 'NeurIPS' : 'ACL', identifiers: {}, tags: i % 5 ? ['ml'] : ['bio'], folderIds: [], files: [],
    readingStatus: 'inbox', addedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', deviceId: 'd', metadataSource: 'user', needsMatch: false
  } as unknown as Paper
}

describe('library search at 10,000 papers', () => {
  const papers = Array.from({ length: 10_000 }, (_, i) => fake(i))

  it('finds the right papers', () => {
    expect(filterPapers(papers, 'number 9999')[0]!.id).toBe('p9999')
    expect(filterPapers(papers, 'lovelace42 2032').every((p) => p.authors[0]!.family === 'Lovelace42' && p.year === 2032)).toBe(true)
    expect(filterPapers(papers, '', 'bio')).toHaveLength(2000)
  })

  it('stays within 100ms per keystroke, including the first search', () => {
    const first = performance.now()
    filterPapers(papers, 'a')
    const cold = performance.now() - first
    const times: number[] = []
    for (const q of ['at', 'att', 'atte', 'attention', 'attention gr', 'attention graph']) {
      const t = performance.now()
      filterPapers(papers, q)
      times.push(performance.now() - t)
    }
    console.log(`search 10k: first ${cold.toFixed(1)}ms, then max ${Math.max(...times).toFixed(1)}ms`)
    expect(cold).toBeLessThan(100)
    expect(Math.max(...times)).toBeLessThan(100)
  })
})
