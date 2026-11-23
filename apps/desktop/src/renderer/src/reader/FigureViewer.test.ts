import { describe, expect, it } from 'vitest'
import { clampView, FIT, fitSize, MAX_ZOOM, zoomAt } from './FigureViewer'

const stage = { w: 1000, h: 600 }

describe('figure viewer sizing', () => {
  it('fits a figure to the stage keeping its shape, and blows small ones up at most 4x', () => {
    expect(fitSize({ w: 476, h: 99 }, stage)).toEqual({ w: 1000, h: 208 })
    expect(fitSize({ w: 576, h: 748 }, stage)).toEqual({ w: 462, h: 600 })
    expect(fitSize({ w: 50, h: 20 }, stage)).toEqual({ w: 200, h: 80 })
  })

  it('zooms around the pointer and never past fit or the maximum', () => {
    const fit = { w: 1000, h: 208 }
    // 在图右边 200px 处放大一倍：那一点还在鼠标下
    const v = zoomAt(FIT, 2, 200, 0, fit, stage)
    expect(v.s).toBe(2)
    expect(v.x).toBe(-200)
    expect(200 - v.x).toBe(2 * 200)
    expect(zoomAt(v, 0.1, 0, 0, fit, stage)).toEqual(FIT)
    expect(zoomAt(FIT, 100, 0, 0, fit, stage).s).toBe(MAX_ZOOM)
  })

  it('only pans where the figure is bigger than the stage, and keeps it covering the stage', () => {
    const fit = { w: 1000, h: 208 }
    // 2 倍：宽 2000（能左右各移 500），高 416 < 600（上下不能移）
    expect(clampView({ s: 2, x: 900, y: 300 }, fit, stage)).toEqual({ s: 2, x: 500, y: 0 })
    expect(clampView({ s: 2, x: -900, y: -300 }, fit, stage)).toEqual({ s: 2, x: -500, y: 0 })
  })
})
