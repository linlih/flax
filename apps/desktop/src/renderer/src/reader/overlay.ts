// 在 PDF.js 的页面上叠一层高亮。用百分比定位，缩放时不用重画；
// PDF.js 重绘页面时会清掉这一层，所以每次 pagerendered 都补上。
// 有评论的高亮在页边放一个小标记（跟 Apple Books、Readwise 一样）：悬停看评论，点一下打开。
// 标记在文字层上面一层，只有标记本身能点，不挡选字。
import type { Annotation } from '@flax/core'
import { rectToPercent, type PageViewLike } from './geometry'

const LAYER = 'hl-layer'
const MARKS = 'hl-marks'
const NOTE_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5.5h14v10H10l-4 3.5v-3.5H5z"/></svg>'

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
  let marks = view.div.querySelector<HTMLDivElement>(`:scope > .${MARKS}`)
  if (!marks) {
    marks = document.createElement('div')
    marks.className = MARKS
    view.div.appendChild(marks)
  }
  const frag = document.createDocumentFragment()
  const markFrag = document.createDocumentFragment()
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
    const comment = a.comment?.trim()
    const first = a.target.rects[0]
    if (comment && first) {
      // 放在离高亮近的那一侧页边，和高亮第一行对齐
      const p = rectToPercent(view, first)
      const right = p.left + p.width / 2 > 50
      const m = document.createElement('div')
      m.className = `hl-mark ${a.type === 'note' ? 'hl-q' : `hl-c-${a.color}`}` + (right ? ' right' : ' left') + (a.id === activeId ? ' on' : '')
      m.dataset['anno'] = a.id
      m.dataset['comment'] = comment.length > 160 ? comment.slice(0, 160) + '…' : comment
      m.style.cssText = `top:${p.top + p.height / 2}%`
      m.innerHTML = NOTE_ICON
      markFrag.appendChild(m)
    }
  }
  layer.replaceChildren(frag)
  marks.replaceChildren(markFrag)
}
