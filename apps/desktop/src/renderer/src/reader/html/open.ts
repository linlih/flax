// 打开网页版：读 PDF 的文字（换算批注要用）→ 从 arXiv 的戳上认出 PDF 是第几版 → 让宿主拿到同一版的网页 → 显示。
// 网页和 PDF 对不上（多半不是同一版）就不用网页版，回到 PDF。
import { arxivVersionIn, pdfTextFromDoc, type PdfText, type PdfTextDocLike } from '@flax/core'
import { HtmlView, type HtmlViewOptions } from './htmlView'

export type HtmlFail = 'none' | 'offline' | 'mismatch' | 'error'

export type Fetched = { raw: string; base: string } | { fail: 'none' | 'offline'; message?: string }

/** 网页的段落至少这么多能在 PDF 里找到，才算同一篇同一版 */
const MIN_MATCH = 0.4

const pdfTexts = new WeakMap<object, Promise<PdfText>>()

/** PDF 的文字只读一次（切换来回不重读） */
export function pdfTextOf(doc: PdfTextDocLike): Promise<PdfText> {
  let p = pdfTexts.get(doc)
  if (!p) {
    p = pdfTextFromDoc(doc)
    pdfTexts.set(doc, p)
  }
  return p
}

export async function openHtml(
  o: Omit<HtmlViewOptions, 'raw' | 'base' | 'pdf'> & { doc: PdfTextDocLike; arxiv: string; fetchHtml: (version: string | null) => Promise<Fetched> }
): Promise<{ view: HtmlView } | { fail: HtmlFail; message?: string }> {
  try {
    const pdf = await pdfTextOf(o.doc)
    const head = pdf.pages.slice(0, 2).map((p) => p.text).join('\n')
    const version = arxivVersionIn(head, o.arxiv)
    const got = await o.fetchHtml(version)
    if ('fail' in got) return { fail: got.fail, ...(got.message ? { message: got.message } : {}) }
    const view = new HtmlView({ ...o, raw: got.raw, base: got.base, pdf })
    if (view.matchRatio < MIN_MATCH) {
      view.destroy()
      return { fail: 'mismatch' }
    }
    return { view }
  } catch (e) {
    return { fail: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}

export const FAIL_TEXT: Record<HtmlFail, string> = {
  none: 'arXiv 上没有这篇的网页版，显示 PDF。',
  offline: '网页版下载不了（没联网？），先显示 PDF。',
  mismatch: '网页版和这份 PDF 对不上（可能不是同一版），显示 PDF。',
  error: '网页版打不开，显示 PDF。'
}
