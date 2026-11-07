// 在 PDF.js 的页面上叠一层高亮。用百分比定位，缩放时不用重画；
// PDF.js 重绘页面时会清掉这一层，所以每次 pagerendered 都补上。
import type { Annotation } from '@paper/core'
import { rectToPercent, type PageViewLike } from './geometry'

const LAYER = 'hl-layer'

export function drawPage(view: PageViewLike, annotations: Annotation[], activeId: string | null): void {
  let layer = view.div.querySelector<HTMLDivElement>(`:scope > .${LAYER}`)
  if (!layer) {
    layer = document.createElement('div')
    layer.className = LAYER
    layer.setAttribute('aria-hidden', 'true')
    // 放在文字层下面：文字仍然能选中
    const text = view.div.querySelector(':scope > .textLayer')
    view.div.insertBefore(layer, text)
  }
  const frag = document.createDocumentFragment()
  for (const a of annotations) {
    if (a.page !== view.id - 1) continue
    for (const r of a.target.rects) {
      // 文字层的字宽和画出来的字形差一点，左右各放宽 1pt
      const p = rectToPercent(view, [r[0] - 1, r[1], r[2] + 1, r[3]])
      const el = document.createElement('div')
      el.className = `hl hl-${a.type} hl-c-${a.color}` + (a.id === activeId ? ' hl-active' : '')
      el.style.cssText = `left:${p.left}%;top:${p.top}%;width:${p.width}%;height:${p.height}%`
      frag.appendChild(el)
    }
    if (a.comment) {
      const first = a.target.rects[0]
      if (first) {
        const p = rectToPercent(view, first)
        const dot = document.createElement('div')
        dot.className = `hl-note hl-c-${a.color}`
        dot.style.cssText = `left:${p.left}%;top:${p.top}%`
        frag.appendChild(dot)
      }
    }
  }
  layer.replaceChildren(frag)
}
