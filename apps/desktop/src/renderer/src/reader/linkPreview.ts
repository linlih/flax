// 引用悬停预览：鼠标停在文中的 [12]、"Figure 2" 这类内部链接上，
// 不用跳过去，就能看到目标位置的一小块页面。
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'

/** PDF 里的目标：页码（从 0 开始）和目标位置（PDF 坐标，单位 pt，原点在左下）；位置可能缺 */
export interface Target {
  pageIndex: number
  x: number | null
  y: number | null
}

/** PDF.js 把内部链接写成 href="#<转义后的目标>"，这里还原回来 */
export function parseHash(href: string): string | unknown[] | null {
  const i = href.indexOf('#')
  if (i < 0 || i === href.length - 1) return null
  const raw = unescape(href.slice(i + 1))
  if (raw.includes('=')) {
    // #page=3 这样的写法
    const m = /(?:^|&)page=(\d+)/.exec(raw)
    return m ? [Number(m[1]) - 1, { name: 'XYZ' }, null, null, null] : null
  }
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v : String(v)
  } catch {
    return raw
  }
}

/** 把显式目标数组读成页码和坐标 */
export function readExplicit(dest: unknown[], pageIndex: number): Target {
  const kind = (dest[1] as { name?: string } | undefined)?.name
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  switch (kind) {
    case 'XYZ': return { pageIndex, x: num(dest[2]), y: num(dest[3]) }
    case 'FitH': case 'FitBH': return { pageIndex, x: null, y: num(dest[2]) }
    case 'FitV': case 'FitBV': return { pageIndex, x: num(dest[2]), y: null }
    case 'FitR': return { pageIndex, x: num(dest[2]), y: num(dest[5]) }
    default: return { pageIndex, x: null, y: null }
  }
}

export async function resolveTarget(doc: PDFDocumentProxy, dest: string | unknown[]): Promise<Target | null> {
  const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest
  if (!Array.isArray(explicit) || explicit.length === 0) return null
  const ref = explicit[0]
  let pageIndex: number
  if (typeof ref === 'number') pageIndex = ref
  else if (ref && typeof ref === 'object') pageIndex = await doc.getPageIndex(ref as Parameters<PDFDocumentProxy['getPageIndex']>[0])
  else return null
  if (pageIndex < 0 || pageIndex >= doc.numPages) return null
  return readExplicit(explicit, pageIndex)
}

interface Item { x: number; y: number; w: number }

/**
 * 预览要截的区域（PDF 坐标）。双栏论文的参考文献在左栏时，只截左栏，
 * 不然左右两栏的条目会混在一起。
 */
export function cropRegion(view: [number, number, number, number], t: Target, items: Item[], height = 110): { left: number; right: number; top: number; bottom: number } {
  const [vx0, vy0, vx1, vy1] = view
  const top = Math.min(vy1, (t.y ?? vy1) + 6)
  const bottom = Math.max(vy0, top - height)
  let left = vx0
  let right = vx1
  if (t.x != null) {
    const mid = (vx0 + vx1) / 2
    const band = items.filter((it) => it.y <= top && it.y >= bottom && it.w > 0)
    // 有从左半边开始、又越过中线很多的行，就是单栏
    const singleColumn = band.some((it) => it.x < mid - 20 && it.x + it.w > mid + 20)
    const hasRight = band.some((it) => it.x > mid)
    if (!singleColumn && hasRight) {
      if (t.x < mid) right = mid
      else left = mid
    }
    left = Math.max(left, Math.min(t.x, right) - 8)
  }
  return { left, right, top, bottom }
}

const itemCache = new WeakMap<PDFPageProxy, Promise<Item[]>>()
function itemsOf(page: PDFPageProxy): Promise<Item[]> {
  let p = itemCache.get(page)
  if (!p) {
    p = page.getTextContent().then((tc) =>
      tc.items.flatMap((it) => ('transform' in it ? [{ x: it.transform[4] as number, y: it.transform[5] as number, w: it.width }] : []))
    )
    itemCache.set(page, p)
  }
  return p
}

/** 画出目标附近的一块页面。字号放大到约 1.5 倍，最宽 maxWidth */
export async function renderPreview(doc: PDFDocumentProxy, t: Target, maxWidth = 440): Promise<{ canvas: HTMLCanvasElement; cssWidth: number; cssHeight: number }> {
  const page = await doc.getPage(t.pageIndex + 1)
  const view = page.view as [number, number, number, number]
  const r = cropRegion(view, t, await itemsOf(page))
  const cssWidth = Math.round(Math.min(maxWidth, (r.right - r.left) * 1.5))
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const scale = (cssWidth / (r.right - r.left)) * dpr
  const viewport = page.getViewport({ scale })
  const [cx0, cy0] = viewport.convertToViewportPoint(r.left, r.top) as [number, number]
  const [cx1, cy1] = viewport.convertToViewportPoint(r.right, r.bottom) as [number, number]
  const w = Math.round(Math.abs(cx1 - cx0))
  const h = Math.round(Math.abs(cy1 - cy0))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, w, h)
  // 只画截取的那一块：把页面整体平移，让截取区域的左上角落在画布原点
  await page.render({ canvas, canvasContext: ctx, viewport, transform: [1, 0, 0, 1, -Math.min(cx0, cx1), -Math.min(cy0, cy1)] }).promise
  return { canvas, cssWidth, cssHeight: h / dpr }
}
