// 整本 PDF 的文字和每段字在页面上的位置。网页版阅读器用它把网页里选中的文字换算成 PDF 的页码和矩形，
// 这样批注照样按 PDF 存，桌面的 PDF 阅读器、同步都不用改。
// 每页的文字和阅读器文字层的拼法一样（每段字直接接上，行尾换行），批注里的原文和前后文才对得上。
// 只依赖 pdf.js 文档对象的形状，不 import pdf.js。
import { mergeRects } from './anchor'
import { skeleton, type Skeleton } from './crossAnchor'
import type { PdfRect } from './model'

export interface PdfTextItem {
  /** 在这一页文字里的 [start, end) */
  start: number
  end: number
  /** pdf.js 的 transform：[a, b, c, d, x, y]，(x, y) 是基线起点 */
  transform: number[]
  width: number
  height: number
}

export interface PdfTextPage {
  text: string
  items: PdfTextItem[]
}

export interface PdfText {
  pages: PdfTextPage[]
  /** 各页文字用换行接起来 */
  all: string
  /** 每页在 all 里从哪开始 */
  pageStart: number[]
  /** all 的骨架，找批注用；第一次用时算 */
  skeleton(): Skeleton
}

interface ItemLike {
  str: string
  hasEOL?: boolean
  transform: number[]
  width: number
  height: number
}

export interface PdfTextDocLike {
  numPages: number
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }>; cleanup(): unknown }>
}

export function pageFromItems(raw: ItemLike[]): PdfTextPage {
  let text = ''
  const items: PdfTextItem[] = []
  for (const it of raw) {
    const start = text.length
    text += it.str
    items.push({ start, end: text.length, transform: it.transform, width: it.width, height: it.height })
    if (it.hasEOL) text += '\n'
  }
  return { text, items }
}

export function buildPdfText(pages: PdfTextPage[]): PdfText {
  const pageStart: number[] = []
  let all = ''
  for (const p of pages) {
    if (pageStart.length) all += '\n'
    pageStart.push(all.length)
    all += p.text
  }
  let sk: Skeleton | null = null
  return { pages, all, pageStart, skeleton: () => (sk ??= skeleton(all)) }
}

export async function pdfTextFromDoc(doc: PdfTextDocLike): Promise<PdfText> {
  const pages: PdfTextPage[] = []
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const c = await page.getTextContent()
    pages.push(pageFromItems(c.items.filter((it): it is ItemLike => !!it && typeof it === 'object' && 'str' in it)))
    page.cleanup()
  }
  return buildPdfText(pages)
}

/** all 里的位置在第几页（从 0 开始） */
export function pdfPageOf(t: PdfText, at: number): number {
  let lo = 0
  let hi = t.pageStart.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (t.pageStart[mid]! <= at) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** 一段字在页面上的框：按字数平分这段字的宽度（同一段字的字宽差不多）。只算横排的字 */
function itemRect(it: PdfTextItem, a: number, b: number): PdfRect | null {
  const len = it.end - it.start
  if (!len || b <= a) return null
  const [ta = 1, tb = 0, tc = 0, td = 1, x = 0, y = 0] = it.transform
  // 竖排、旋转的字（比如 arXiv 在页边盖的戳）不管
  if (Math.abs(tb) > 0.01 * Math.abs(ta) || Math.abs(tc) > 0.01 * Math.abs(td)) return null
  const h = it.height || Math.hypot(tc, td) || Math.abs(td)
  const w = it.width
  return [x + (w * (a - it.start)) / len, y - h * 0.22, x + (w * (b - it.start)) / len, y + h * 0.88]
}

/** 第 page 页文字里 [start, end) 这一段在页面上的矩形（PDF 坐标，同一行的合成一个） */
export function rectsOnPage(t: PdfText, page: number, start: number, end: number): PdfRect[] {
  const p = t.pages[page]
  if (!p) return []
  const out: PdfRect[] = []
  for (const it of p.items) {
    if (it.end <= start || it.start >= end) continue
    const r = itemRect(it, Math.max(start, it.start), Math.min(end, it.end))
    if (r) out.push(r)
  }
  return mergeRects(out)
}

/** 这一页文字里 at 这个位置所在那一行的上边缘（PDF 坐标），阅读位置用；找不到返回 null */
export function topAt(t: PdfText, page: number, at: number): number | null {
  const p = t.pages[page]
  if (!p) return null
  for (const it of p.items) {
    if (it.end <= at) continue
    const r = itemRect(it, it.start, Math.max(it.end, it.start + 1))
    if (r) return Math.round(r[3] + 4)
  }
  return null
}
