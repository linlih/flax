import { describe, expect, test } from 'vitest'
import { cropRegion, parseHash, readExplicit } from './linkPreview'

describe('parseHash', () => {
  test('named destination', () => {
    expect(parseHash('#cite.vaswani2017')).toBe('cite.vaswani2017')
  })
  test('explicit destination array, escaped', () => {
    const dest = [{ num: 12, gen: 0 }, { name: 'XYZ' }, 72, 700, null]
    expect(parseHash('#' + escape(JSON.stringify(dest)))).toEqual(dest)
  })
  test('page parameter', () => {
    expect(parseHash('#page=3')).toEqual([2, { name: 'XYZ' }, null, null, null])
  })
  test('empty', () => {
    expect(parseHash('#')).toBeNull()
    expect(parseHash('https://example.org')).toBeNull()
  })
})

describe('readExplicit', () => {
  test('XYZ keeps both coordinates', () => {
    expect(readExplicit([0, { name: 'XYZ' }, 72, 500, 0], 4)).toEqual({ pageIndex: 4, x: 72, y: 500 })
  })
  test('FitH has only top', () => {
    expect(readExplicit([0, { name: 'FitH' }, 640], 1)).toEqual({ pageIndex: 1, x: null, y: 640 })
  })
  test('Fit has no position', () => {
    expect(readExplicit([0, { name: 'Fit' }], 0)).toEqual({ pageIndex: 0, x: null, y: null })
  })
})

describe('cropRegion', () => {
  const view: [number, number, number, number] = [0, 0, 612, 792]
  // 双栏：左栏 x 54–300，右栏 x 312–558
  const twoCol = Array.from({ length: 10 }, (_, i) => [{ x: 54, y: 600 - i * 12, w: 240 }, { x: 312, y: 600 - i * 12, w: 240 }]).flat()
  const oneCol = Array.from({ length: 10 }, (_, i) => ({ x: 72, y: 600 - i * 12, w: 468 }))

  test('left column of a two-column page crops to the left half', () => {
    const r = cropRegion(view, { pageIndex: 0, x: 54, y: 600 }, twoCol)
    expect(r.right).toBe(306)
    expect(r.left).toBe(46)
    expect(r.top).toBe(606)
    expect(r.bottom).toBe(496)
  })
  test('right column crops to the right half', () => {
    const r = cropRegion(view, { pageIndex: 0, x: 312, y: 600 }, twoCol)
    expect(r.left).toBe(306)
    expect(r.right).toBe(612)
  })
  test('single column keeps full width', () => {
    const r = cropRegion(view, { pageIndex: 0, x: 72, y: 600 }, oneCol)
    expect(r.right).toBe(612)
  })
  test('no position shows the top of the page', () => {
    const r = cropRegion(view, { pageIndex: 0, x: null, y: null }, oneCol)
    expect(r).toEqual({ left: 0, right: 612, top: 792, bottom: 682 })
  })
})
