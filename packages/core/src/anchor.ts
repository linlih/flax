// 文本批注的"原文 + 前后文"定位（参考 W3C Web Annotation 的 TextQuoteSelector）。
// 不同渲染器的坐标对不上时，用它在页面文字里重新找到这段话。
import type { PdfRect, TextQuote } from './model'

const CONTEXT = 32

/** 空白统一成一个空格，PDF 文字层的换行和多余空格不影响匹配 */
export function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** 选中的是页面文字 text 里 [start, end) 这一段 */
export function quoteAt(text: string, start: number, end: number): TextQuote {
  return {
    exact: squash(text.slice(start, end)),
    prefix: squash(text.slice(Math.max(0, start - CONTEXT), start)),
    suffix: squash(text.slice(end, end + CONTEXT))
  }
}

/** 在页面文字里找 quote，返回 [start, end)；有多处时用前后文挑最像的一处 */
export function findQuote(text: string, quote: TextQuote): [number, number] | null {
  const exact = quote.exact
  if (!exact) return null
  // 在压缩过空白的文字上找，再换算回原文的位置
  const map: number[] = []
  let flat = ''
  let space = false
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i]!)) {
      space = flat.length > 0
      continue
    }
    if (space) {
      flat += ' '
      map.push(i)
      space = false
    }
    flat += text[i]
    map.push(i)
  }
  let best: [number, number] | null = null
  let bestScore = -1
  for (let at = flat.indexOf(exact); at !== -1; at = flat.indexOf(exact, at + 1)) {
    const before = flat.slice(Math.max(0, at - quote.prefix.length - 1), at).trimEnd()
    const after = flat.slice(at + exact.length).trimStart()
    const score = commonSuffix(before, quote.prefix) + commonPrefix(after, quote.suffix)
    if (score > bestScore) {
      bestScore = score
      best = [map[at]!, map[at + exact.length - 1]! + 1]
    }
  }
  return best
}

function commonPrefix(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}
function commonSuffix(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}

/** 同一行上相邻的矩形合成一个，存储更小，画出来也不会有缝 */
export function mergeRects(rects: PdfRect[]): PdfRect[] {
  const norm = rects
    .map(([x0, y0, x1, y1]): PdfRect => [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)])
    .filter(([x0, y0, x1, y1]) => x1 - x0 > 0.5 && y1 - y0 > 0.5)
    .sort((a, b) => b[3] - a[3] || a[0] - b[0])
  const out: PdfRect[] = []
  for (const r of norm) {
    const last = out[out.length - 1]
    if (last) {
      const h = Math.min(last[3] - last[1], r[3] - r[1])
      const overlapY = Math.min(last[3], r[3]) - Math.max(last[1], r[1])
      // 同一行：纵向重叠超过一半，横向挨着（允许一个字宽的空隙）
      if (overlapY > h * 0.5 && r[0] <= last[2] + h) {
        last[0] = Math.min(last[0], r[0])
        last[1] = Math.min(last[1], r[1])
        last[2] = Math.max(last[2], r[2])
        last[3] = Math.max(last[3], r[3])
        continue
      }
    }
    out.push([...r])
  }
  return out.map((r) => r.map((v) => Math.round(v * 100) / 100) as PdfRect)
}
