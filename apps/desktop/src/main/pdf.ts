// 读 PDF 的文字和自带信息，给识别用。只读前两页，大文件也很快。
import type { PdfFacts, TextLine } from '@flax/core'

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
let pdfjs: Promise<PdfJs> | null = null
const load = () => (pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs'))

export class NotAPdfError extends Error {}

export async function readPdfFacts(data: Uint8Array, fileName: string): Promise<PdfFacts> {
  const { getDocument } = await load()
  // pdfjs 会接管传进去的缓冲区，复制一份避免调用方的数据被清空
  const task = getDocument({ data: data.slice(), disableFontFace: true, useSystemFonts: false, verbosity: 0 })
  let doc
  try {
    doc = await task.promise
  } catch (e) {
    throw new NotAPdfError(e instanceof Error ? e.message : String(e))
  }
  try {
    const meta = await doc.getMetadata().catch(() => null)
    const raw = (meta?.info ?? {}) as Record<string, unknown>
    const str = (k: string) => (typeof raw[k] === 'string' && (raw[k] as string).trim() ? (raw[k] as string).trim() : undefined)
    const info: PdfFacts['info'] = {}
    for (const [k, key] of [['Title', 'title'], ['Author', 'author'], ['Subject', 'subject'], ['Keywords', 'keywords']] as const) {
      const v = str(k)
      if (v) info[key] = v
    }

    let text = ''
    let lines: TextLine[] = []
    for (let n = 1; n <= Math.min(2, doc.numPages); n++) {
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      const items = content.items.flatMap((it) => ('str' in it ? [it] : []))
      text += items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('') + '\n'
      if (n === 1) lines = toLines(items.map((it) => ({ str: it.str, size: Math.hypot(it.transform[2] ?? 0, it.transform[3] ?? 0), x: it.transform[4] ?? 0, y: it.transform[5] ?? 0 })))
      page.cleanup()
    }
    return { fileName, info, text, lines, pageCount: doc.numPages }
  } finally {
    await task.destroy()
  }
}

/** 把同一基线、同一字号的文字片段合成一行 */
function toLines(items: { str: string; size: number; x: number; y: number }[]): TextLine[] {
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
