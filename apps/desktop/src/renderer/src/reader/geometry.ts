// 屏幕坐标和 PDF 页面坐标之间的换算，以及从选中的文字算出批注位置。
import { mergeRects, quoteAt, type PdfRect, type TextQuote } from '@flax/core'

interface Viewport {
  width: number
  height: number
  convertToPdfPoint(x: number, y: number): number[]
  convertToViewportPoint(x: number, y: number): number[]
}

/** PDF.js 的 PDFPageView 里我们用到的部分 */
export interface PageViewLike {
  id: number
  div: HTMLDivElement
  viewport: Viewport
  pdfPage?: { getViewport(o: { scale: number }): Viewport } | null
}

export interface SelectionPart {
  /** 从 0 开始 */
  page: number
  rects: PdfRect[]
  quote: TextQuote
}

/** 页面在屏幕上的位置；页面 div 的 border 不算在里面 */
function pageBox(view: PageViewLike): DOMRect {
  const r = view.div.getBoundingClientRect()
  const cs = getComputedStyle(view.div)
  const bl = parseFloat(cs.borderLeftWidth) || 0
  const bt = parseFloat(cs.borderTopWidth) || 0
  return new DOMRect(r.left + bl, r.top + bt, view.viewport.width, view.viewport.height)
}

export function clientToPdf(view: PageViewLike, x: number, y: number): [number, number] {
  const b = pageBox(view)
  const [px, py] = view.viewport.convertToPdfPoint(x - b.left, y - b.top)
  return [px!, py!]
}

export function pageAt(views: PageViewLike[], x: number, y: number): PageViewLike | undefined {
  return views.find((v) => {
    const b = pageBox(v)
    return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom
  })
}

/** 文字层的全部文字。PDF.js 在每行末尾放一个 <br>，这里算成换行，不然上一行的末尾和下一行的开头会粘在一起 */
function layerPieces(layer: Element): { node: Node; at: number }[] {
  const out: { node: Node; at: number }[] = []
  const walk = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  let at = 0
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      out.push({ node: n, at })
      at += (n as Text).data.length
    } else if ((n as Element).tagName === 'BR') {
      out.push({ node: n, at })
      at += 1
    }
  }
  out.push({ node: layer, at })
  return out
}

function layerText(layer: Element): string {
  let text = ''
  const walk = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) text += (n as Text).data
    else if ((n as Element).tagName === 'BR') text += '\n'
  }
  return text
}

/** 选区端点 (node, offset) 在文字层文字里的位置 */
function offsetIn(layer: Element, node: Node, offset: number): number {
  const pieces = layerPieces(layer)
  if (node.nodeType === Node.TEXT_NODE) return (pieces.find((p) => p.node === node)?.at ?? 0) + offset
  // 端点落在元素上：取它后面第一段文字的起点
  const r = document.createRange()
  try {
    r.setStart(node, offset)
  } catch {
    return 0
  }
  for (const p of pieces) if (p.node !== layer && r.comparePoint(p.node, 0) >= 0) return p.at
  return pieces[pieces.length - 1]!.at
}

/** 把当前选中的文字按页拆开，算出每页的矩形（PDF 坐标）和原文 */
export function selectionParts(range: Range, views: PageViewLike[]): SelectionPart[] {
  const byPage = new Map<number, PdfRect[]>()
  for (const r of range.getClientRects()) {
    if (r.width < 1 || r.height < 1) continue
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const v = pageAt(views, cx, cy)
    if (!v || r.height > v.viewport.height * 0.2) continue
    const [x0, y0] = clientToPdf(v, r.left, r.bottom)
    const [x1, y1] = clientToPdf(v, r.right, r.top)
    const list = byPage.get(v.id) ?? []
    list.push([x0, y0, x1, y1])
    byPage.set(v.id, list)
  }
  const parts: SelectionPart[] = []
  for (const [id, rects] of byPage) {
    const view = views.find((v) => v.id === id)!
    const layer = view.div.querySelector('.textLayer')
    if (!layer) continue
    const text = layerText(layer)
    // 选区在这一页里的起止：起点在别的页上就从页首算，终点在别的页上就到页尾
    const start = layer.contains(range.startContainer) ? offsetIn(layer, range.startContainer, range.startOffset) : 0
    const end = layer.contains(range.endContainer) ? offsetIn(layer, range.endContainer, range.endOffset) : text.length
    const quote = quoteAt(text, start, end)
    const merged = mergeRects(rects)
    if (merged.length && quote.exact) parts.push({ page: id - 1, rects: merged, quote })
  }
  return parts.sort((a, b) => a.page - b.page)
}

/** PDF 矩形换成页面上的百分比位置，缩放时不用重画 */
export function rectToPercent(view: PageViewLike, r: PdfRect): { left: number; top: number; width: number; height: number } {
  const vp = view.pdfPage?.getViewport({ scale: 1 }) ?? view.viewport
  const [a, b] = vp.convertToViewportPoint(r[0], r[1])
  const [c, d] = vp.convertToViewportPoint(r[2], r[3])
  const x0 = Math.min(a!, c!), x1 = Math.max(a!, c!), y0 = Math.min(b!, d!), y1 = Math.max(b!, d!)
  return { left: (x0 / vp.width) * 100, top: (y0 / vp.height) * 100, width: ((x1 - x0) / vp.width) * 100, height: ((y1 - y0) / vp.height) * 100 }
}

export function hitTest(rects: PdfRect[], x: number, y: number, pad = 1): boolean {
  return rects.some(([x0, y0, x1, y1]) => x >= Math.min(x0, x1) - pad && x <= Math.max(x0, x1) + pad && y >= Math.min(y0, y1) - pad && y <= Math.max(y0, y1) + pad)
}
