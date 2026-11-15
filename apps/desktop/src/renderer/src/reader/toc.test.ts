import { describe, expect, it } from 'vitest'
import { ancestors, currentItem, loadOutline, visibleItems, type OutlineDoc } from './toc'

// 一本编的书：两章，第一章有两节；一条指向命名位置，一条跳不了
const doc: OutlineDoc = {
  getOutline: async () => [
    { title: 'Chapter 1', dest: [{ num: 10 }], items: [{ title: ' 1.1  Start ', dest: 'sec1.1' }, { title: '1.2 More', dest: [{ num: 30 }] }] },
    { title: 'Chapter 2', dest: [49] },
    { title: 'Website', dest: null },
    { title: '', dest: null }
  ],
  getDestination: async (id) => (id === 'sec1.1' ? [{ num: 12 }] : null),
  getPageIndex: async (ref) => (ref as { num: number }).num - 1
}

describe('outline', () => {
  it('flattens the tree with levels and page numbers', async () => {
    const items = await loadOutline(doc)
    expect(items.map((i) => [i.title, i.level, i.parent, i.page])).toEqual([
      ['Chapter 1', 0, -1, 10],
      ['1.1 Start', 1, 0, 12],
      ['1.2 More', 1, 0, 30],
      ['Chapter 2', 0, -1, 50],
      ['Website', 0, -1, undefined]
    ])
    expect(items[0]!.hasKids).toBe(true)
  })
  it('is empty for a PDF without an outline', async () => {
    expect(await loadOutline({ ...doc, getOutline: async () => null })).toEqual([])
  })
  it('finds the section the current page is in', async () => {
    const items = await loadOutline(doc)
    expect(currentItem(items, 1)).toBe(-1)
    expect(currentItem(items, 10)).toBe(0)
    expect(currentItem(items, 29)).toBe(1)
    expect(currentItem(items, 200)).toBe(3)
    expect(ancestors(items, 2)).toEqual([0])
  })
  it('hides what is under a collapsed item', async () => {
    const items = await loadOutline(doc)
    expect(visibleItems(items, new Set()).map((i) => i.id)).toEqual([0, 3, 4])
    expect(visibleItems(items, new Set([0])).map((i) => i.id)).toEqual([0, 1, 2, 3, 4])
  })
})
