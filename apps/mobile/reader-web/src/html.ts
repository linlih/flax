// 手机阅读器的网页版模式（arXiv HTML）：显示、批注换算都用桌面的 HtmlView，这里只接上和 RN 之间的消息。
// 打开流程：读 PDF 的文字 → 认出版本 → 问 RN 要这一版的网页（RN 下载、存在缓存里）→ 从 file:// 读进来显示。
// 打不开（没有网页版、没联网、和 PDF 对不上）就告诉 RN，由 main.ts 接着用 PDF 打开。
import type { Annotation } from '@flax/core'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { HtmlView } from '../../../desktop/src/renderer/src/reader/html/htmlView'
import { openHtml, type Fetched, type HtmlFail } from '../../../desktop/src/renderer/src/reader/html/open'
import '../../../desktop/src/renderer/src/reader/html/html.css'
import { makeTapper, markLookup, quietSelection, selectionQuiet, sentenceAround, wordAt } from './lookup'

type Post = (m: Record<string, unknown>) => void

export interface HtmlReply {
  ok: boolean
  base?: string
  reason?: 'none' | 'offline'
  message?: string
}

export interface HtmlMode {
  view: HtmlView
  setAnnotations(annos: Annotation[], active: string | null): void
  goto(page: number, anno?: string, quote?: string): void
  find(query: string | null, again?: boolean, previous?: boolean): void
  zoom(dir: 1 | -1 | 0): void
  back(): void
  mark(): void
}

let waiting: ((r: HtmlReply) => void) | null = null

/** RN 回复了网页在哪 */
export function htmlReply(r: HtmlReply): void {
  const w = waiting
  waiting = null
  w?.(r)
}

/** file:// 的页面用 fetch 读不了本机文件，XHR 可以 */
function readLocal(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest()
    x.open('GET', url)
    x.onload = () => (x.status === 0 || x.status === 200 ? resolve(x.responseText) : reject(new Error(`HTTP ${x.status}`)))
    x.onerror = () => reject(new Error('读不了网页文件'))
    x.send()
  })
}

export async function startHtml(o: {
  doc: PDFDocumentProxy
  arxiv: string
  post: Post
  annotations: Annotation[]
  position: { page: number; top: number } | null
  jump: { page: number; anno?: string } | null
  topInset: number
}): Promise<HtmlMode | { fail: HtmlFail; message?: string }> {
  const scroller = document.getElementById('html') as HTMLDivElement
  const host = document.getElementById('htmlhost') as HTMLDivElement
  scroller.hidden = false
  const fetchHtml = (version: string | null) =>
    new Promise<Fetched>((resolve) => {
      waiting = (r) => {
        if (!r.ok || !r.base) return resolve({ fail: r.reason ?? 'offline', ...(r.message ? { message: r.message } : {}) })
        readLocal(`${r.base}index.html`).then(
          (raw) => resolve({ raw, base: r.base! }),
          (e: Error) => resolve({ fail: 'offline', message: e.message })
        )
      }
      o.post({ type: 'needHtml', version })
    })

  const r = await openHtml({
    doc: o.doc,
    arxiv: o.arxiv,
    scroller,
    host,
    topInset: o.topInset,
    fetchHtml,
    onPage: (page, total) => o.post({ type: 'page', page, total }),
    onPosition: (p) => o.post({ type: 'position', page: p.page, left: 0, top: p.top ?? 0, scale: 'page-width' }),
    onLink: (url) => {
      o.post({ type: 'link', url })
      return true
    },
    onJump: (on) => o.post({ type: 'canBack', on })
  })
  if ('fail' in r) {
    scroller.hidden = true
    return r
  }
  const view = r.view
  document.getElementById('scroll')!.hidden = true

  let annos = o.annotations
  let active: string | null = null
  const paint = () => o.post({ type: 'missing', ids: view.paint(annos, active).map((a) => a.id) })
  paint()

  const goto: HtmlMode['goto'] = (page, anno, quote) => {
    if (quote) return view.gotoQuote(quote, page)
    if (anno) {
      active = anno
      paint()
      if (view.scrollToAnno(anno)) return
    }
    view.gotoPage(page)
  }
  if (o.jump) goto(o.jump.page, o.jump.anno)
  else if (o.position) view.gotoPage(o.position.page, o.position.top)
  else view.report()
  o.post({ type: 'loaded', pages: view.pageCount, mode: 'html', font: view.fontScale })

  // —— 选字：选区稳定一会儿再告诉 RN。PDF 里找不到的字也给 RN（能复制、翻译，不能标注）——
  let selTimer: ReturnType<typeof setTimeout> | undefined
  let lastSel = ''
  document.addEventListener('selectionchange', () => {
    clearTimeout(selTimer)
    selTimer = setTimeout(() => {
      if (selectionQuiet()) return
      const sel = document.getSelection()
      const range = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null
      const text = range ? view.selectedText(range) : ''
      const parts = range && text ? view.selectionParts(range) : []
      const key = `${text}|${parts.map((p) => `${p.page}:${p.quote.exact}`).join('|')}`
      if (key === lastSel) return
      lastSel = key
      o.post(text ? { type: 'selection', parts, text } : { type: 'selection', parts: null })
    }, 350)
  })

  // —— 点一下：点在批注上选中它；点链接、脚注交给 HtmlView；点空白切换工具栏 ——
  let down: { x: number; y: number; t: number } | null = null
  scroller.addEventListener('pointerdown', (e) => {
    down = e.isPrimary ? { x: e.clientX, y: e.clientY, t: Date.now() } : null
  })
  const tapper = makeTapper(
    (e) => {
      const id = view.annoAt(e.target)
      if (id) return o.post({ type: 'tapAnno', id })
      o.post({ type: 'tap' })
    },
    (e) => {
      // 双击查词。句子取词所在的段落（公式、脚注不算进去）
      const word = wordAt(e.clientX, e.clientY, host)
      const text = word ? view.selectedText(word) : ''
      if (!word || !text) return
      const block = (word.startContainer.parentElement?.closest('p, li, figcaption, td, th, h1, h2, h3, h4, h5, h6, .ltx_para, .ltx_caption') ?? host) as Element
      quietSelection()
      markLookup(word)
      o.post({ type: 'lookup', word: text, sentence: sentenceAround(word, block, (r) => view.selectedText(r)), parts: view.selectionParts(word) })
    }
  )
  scroller.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10 || Date.now() - down.t > 400) return
    down = null
    if (!document.getSelection()?.isCollapsed) return
    if ((e.target as Element).closest('a, .ltx_note')) return
    tapper(e)
  })

  return {
    view,
    setAnnotations(next, act) {
      annos = next
      active = act
      paint()
    },
    goto,
    find(query, again = false, previous = false) {
      if (query === null || !query.trim()) {
        view.clearFind()
        return
      }
      const res = view.find(query, again, previous)
      o.post({ type: 'find', current: res.current, total: res.total, pending: false, ...(res.total ? {} : { notFound: true }) })
    },
    zoom(dir) {
      o.post({ type: 'font', scale: view.zoom(dir) })
    },
    back() {
      view.back()
    },
    mark() {
      view.markOrigin()
    }
  }
}
