// 从打开的 PDF（pdf.js 的文档对象）读识别要用的信息：自带的标题作者、前两页的文字、第一页带字号的文字行，书再找 ISBN。
// 桌面（Node 版 pdf.js）和手机（WebView 里的 pdf.js）都用这一份，结果一样，识别出来的标题作者也一样。
// 这里只依赖 pdf.js 文档对象的形状，不 import pdf.js。
import { extractIsbn } from './ids'
import type { PdfFacts, TextLine } from './metadata'

/** 页数不少于这么多才当成书去找 ISBN：论文集里的单篇论文也印着 ISBN，那是整本论文集的 */
export const BOOK_PAGES = 50

interface TextItemLike {
  str: string
  hasEOL?: boolean
  transform: number[]
}

export interface PdfDocLike {
  numPages: number
  getMetadata(): Promise<{ info?: unknown }>
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }>; cleanup(): unknown }>
}

export async function pdfFactsFromDoc(doc: PdfDocLike, fileName: string): Promise<PdfFacts> {
  const meta = await doc.getMetadata().catch(() => null)
  const raw = (meta?.info ?? {}) as Record<string, unknown>
  const str = (k: string) => (typeof raw[k] === 'string' && (raw[k] as string).trim() ? (raw[k] as string).trim() : undefined)
  const info: PdfFacts['info'] = {}
  for (const [k, key] of [['Title', 'title'], ['Author', 'author'], ['Subject', 'subject'], ['Keywords', 'keywords']] as const) {
    const v = str(k)
    if (v) info[key] = v
  }

  const read = async (n: number) => {
    const page = await doc.getPage(n)
    const content = await page.getTextContent()
    const items = content.items.filter((it): it is TextItemLike => !!it && typeof it === 'object' && 'str' in it)
    page.cleanup()
    return items
  }
  const plain = (items: TextItemLike[]) => items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('') + '\n'

  let text = ''
  let lines: TextLine[] = []
  for (let n = 1; n <= Math.min(2, doc.numPages); n++) {
    const items = await read(n)
    text += plain(items)
    // 书的第一页常常是一张封面图，没有字：用前两页里第一个有字的
    if (!lines.length) lines = toLines(items.map((it) => ({ str: it.str, size: Math.hypot(it.transform[2] ?? 0, it.transform[3] ?? 0), x: it.transform[4] ?? 0, y: it.transform[5] ?? 0 })))
  }
  const facts: PdfFacts = { fileName, info, text, lines, pageCount: doc.numPages }
  if (doc.numPages >= BOOK_PAGES) {
    // 版权页一般在前十来页，中文书也有放在最后的
    let isbn = extractIsbn(text)
    const more = [...range(3, Math.min(12, doc.numPages)), ...range(Math.max(13, doc.numPages - 2), doc.numPages)]
    for (const n of more) {
      if (isbn) break
      isbn = extractIsbn(plain(await read(n).catch(() => [])))
    }
    if (isbn) facts.isbn = isbn
  }
  return facts
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i)
}

/** 把同一基线、同一字号的文字片段合成一行 */
export function toLines(items: { str: string; size: number; x: number; y: number }[]): TextLine[] {
  const rows: { y: number; size: number; parts: { x: number; s: string }[] }[] = []
  for (const it of items) {
    if (!it.str.trim()) continue
    const size = Math.round(it.size * 10) / 10
    const row = rows.find((r) => Math.abs(r.y - it.y) < size * 0.4 && Math.abs(r.size - size) < 0.6)
    if (row) row.parts.push({ x: it.x, s: it.str })
    else rows.push({ y: it.y, size, parts: [{ x: it.x, s: it.str }] })
  }
  return rows.map((r) => ({ y: r.y, size: r.size, text: r.parts.sort((a, b) => a.x - b.x).map((p) => p.s).join(' ').replace(/\s+/g, ' ').trim() }))
}
