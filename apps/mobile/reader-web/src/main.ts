// 手机版阅读器的网页部分：PDF.js 的 PDFViewer 负责渲染和文字层，高亮层和选区换算用桌面的 geometry.ts、overlay.ts。
// 只负责显示和收集操作；批注的增删改都发给 React Native，由那边的 Library 写数据库（只有一个地方写数据）。
//
// RN → 网页：window.flaxReader.receive(消息)
//   { type: 'open', url, annotations, position, jump, dark }   打开文档
//   { type: 'annotations', annotations, active }               批注变了
//   { type: 'goto', page, anno? }                              跳到某页 / 某条批注
//   { type: 'goto', page, quote }                             跳到某页并找到那句话（AI 回答里的引用）
//   { type: 'clearSelection' }
//   { type: 'find', query, again?, previous? } / { type: 'closeFind' }  在文中查找
//   { type: 'zoom', dir: 1 | -1 | 0 }                           放大、缩小、适合宽度
//   { type: 'dark', on }                                       页面深色显示
//   { type: 'facts', id, url, fileName }                       不打开显示，只读出识别用的信息（导入时用，见 src/pdfFacts.tsx）
// 网页 → RN：window.ReactNativeWebView.postMessage(JSON)
//   ready / loaded { pages } / error { message } / page { page, total } / position { page, left, top, scale }
//   selection { parts, text } 或 { parts: null } / tapAnno { id } / tap
//   find { current, total, pending } / link { url }（外部链接） / facts { id, facts } 或 { id, error, notPdf }
import * as pdfjsLib from 'pdfjs-dist'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline'
import { pdfFactsFromDoc, type Annotation } from '@flax/core'
import { clientToPdf, hitTest, pageAt, selectionParts, type PageViewLike } from '../../../desktop/src/renderer/src/reader/geometry'
import { drawPage } from '../../../desktop/src/renderer/src/reader/overlay'
import 'pdfjs-dist/web/pdf_viewer.css'
import '@flax/ui/tokens.css'
import '@flax/ui/highlights.css'
import './reader.css'

// pdf_viewer.mjs 在加载时读 globalThis.pdfjsLib，要先设好再动态加载
;(globalThis as unknown as { pdfjsLib: typeof pdfjsLib }).pdfjsLib = pdfjsLib
GlobalWorkerOptions.workerPort = new PdfWorker()

type Msg =
  | { type: 'open'; url: string; annotations: Annotation[]; position: { page: number; left: number; top: number; scale: string } | null; jump: { page: number; anno?: string } | null; dark: boolean }
  | { type: 'annotations'; annotations: Annotation[]; active: string | null }
  | { type: 'goto'; page: number; anno?: string; quote?: string }
  | { type: 'clearSelection' }
  | { type: 'find'; query: string; again?: boolean; previous?: boolean }
  | { type: 'closeFind' }
  | { type: 'zoom'; dir: 1 | -1 | 0 }
  | { type: 'dark'; on: boolean }
  | { type: 'facts'; id: string; url: string; fileName: string }

const post = (m: Record<string, unknown>) => (window as unknown as { ReactNativeWebView?: { postMessage(s: string): void } }).ReactNativeWebView?.postMessage(JSON.stringify(m))

window.addEventListener('error', (e) => post({ type: 'error', message: String(e.message) }))
window.addEventListener('unhandledrejection', (e) => post({ type: 'error', message: String((e.reason as Error)?.message ?? e.reason) }))

const ASSETS = new URL('./', location.href).href
let annos: Annotation[] = []
let active: string | null = null
let views: () => PageViewLike[] = () => []
let redraw: () => void = () => {}
let goto: (page: number, anno?: string, quote?: string) => void = () => {}
let find: (m: Extract<Msg, { type: 'find' }> | null) => void = () => {}
let zoom: (dir: 1 | -1 | 0) => void = () => {}

const docOptions = (url: string) => ({
  url,
  cMapUrl: `${ASSETS}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${ASSETS}standard_fonts/`,
  wasmUrl: `${ASSETS}wasm/`,
  iccUrl: `${ASSETS}iccs/`,
  // file:// 不支持分段读，一次读完
  disableRange: true,
  disableStream: true
})

/** 导入时读标题作者：只解析，不渲染 */
async function facts(m: Extract<Msg, { type: 'facts' }>) {
  let task
  try {
    task = getDocument({ ...docOptions(m.url), disableFontFace: true })
    const doc = await task.promise
    post({ type: 'facts', id: m.id, facts: await pdfFactsFromDoc(doc, m.fileName) })
  } catch (e) {
    const name = (e as { name?: string }).name ?? ''
    post({ type: 'facts', id: m.id, error: e instanceof Error ? e.message : String(e), notPdf: name === 'InvalidPDFException' || name === 'PasswordException' })
  } finally {
    void task?.destroy()
  }
}

const setDark = (on: boolean) => {
  document.documentElement.classList.toggle('paper-dark', on)
  document.documentElement.classList.toggle('paper-light', !on)
}

async function open(m: Extract<Msg, { type: 'open' }>) {
  setDark(m.dark)
  annos = m.annotations
  const { EventBus, PDFLinkService, PDFViewer, LinkTarget, PDFFindController } = await import('pdfjs-dist/web/pdf_viewer.mjs')
  const container = document.getElementById('scroll') as HTMLDivElement
  const eventBus = new EventBus()
  const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK })
  const findController = new PDFFindController({ eventBus, linkService })
  const viewer = new PDFViewer({ container, viewer: document.getElementById('viewer') as HTMLDivElement, eventBus, linkService, findController, removePageBorders: true })
  linkService.setViewer(viewer)

  // —— 查找 ——
  let lastQuery = ''
  const dispatchFind = (query: string, type: '' | 'again', previous = false) =>
    eventBus.dispatch('find', { source: null, type, query, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: previous, matchDiacritics: false })
  find = (f) => {
    if (!f || !f.query.trim()) {
      lastQuery = ''
      eventBus.dispatch('findbarclose', { source: null })
      return
    }
    const again = !!f.again && f.query === lastQuery
    lastQuery = f.query
    dispatchFind(f.query, again ? 'again' : '', !!f.previous)
  }
  eventBus.on('updatefindmatchescount', ({ matchesCount }: { matchesCount: { current: number; total: number } }) => post({ type: 'find', current: matchesCount.current, total: matchesCount.total, pending: false }))
  eventBus.on('updatefindcontrolstate', ({ state, matchesCount }: { state: number; matchesCount: { current: number; total: number } }) =>
    post({ type: 'find', current: matchesCount.current, total: matchesCount.total, pending: state === 3, notFound: state === 1 })
  )

  // —— 缩放：按钮一档 10%；0 是回到适合宽度 ——
  zoom = (dir) => {
    if (dir === 0) viewer.currentScaleValue = 'page-width'
    else viewer.updateScale({ steps: dir })
  }

  // —— 外部链接交给系统浏览器（WebView 里不开别的网页）；论文内部的链接 pdf.js 自己跳 ——
  container.addEventListener(
    'click',
    (e) => {
      const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('.annotationLayer a[href]')
      if (!a) return
      const href = a.getAttribute('href') ?? ''
      if (/^(https?|mailto):/i.test(href)) {
        e.preventDefault()
        e.stopPropagation()
        post({ type: 'link', url: href })
      }
    },
    true
  )

  views = () => {
    const out: PageViewLike[] = []
    for (let i = 0; i < viewer.pagesCount; i++) out.push(viewer.getPageView(i) as unknown as PageViewLike)
    return out
  }
  redraw = () => {
    for (const v of views()) if (v.div.querySelector('.canvasWrapper')) drawPage(v, annos, active)
  }
  goto = (page, anno, quote) => {
    if (quote) {
      // 和桌面一样：太长的句子只找开头几个词，跨行、连字符更容易对上；中文按字数截
      viewer.currentPageNumber = Math.min(Math.max(1, page), viewer.pagesCount)
      const words = quote.replace(/\s+/g, ' ').trim().split(' ')
      const q = /[\u3400-\u9fff]/.test(quote) ? quote.replace(/\s+/g, '').slice(0, 24) : words.slice(0, 10).join(' ')
      if (q) find({ type: 'find', query: q })
      return
    }
    const a = anno ? annos.find((x) => x.id === anno) : undefined
    const r = a?.target.rects[0]
    if (a && r) {
      active = a.id
      redraw()
      viewer.scrollPageIntoView({ pageNumber: a.page + 1, destArray: [null, { name: 'XYZ' }, r[0] - 20, Math.max(r[1], r[3]) + 80, null], allowNegativeOffset: true })
    } else viewer.scrollPageIntoView({ pageNumber: Math.max(1, Math.min(page, viewer.pagesCount)) })
  }

  let restored = false
  let posTimer: ReturnType<typeof setTimeout> | undefined
  eventBus.on('pagesinit', () => {
    viewer.currentScaleValue = 'page-width'
    if (m.jump) goto(m.jump.page, m.jump.anno)
    else if (m.position) viewer.scrollPageIntoView({ pageNumber: Math.min(m.position.page, viewer.pagesCount), destArray: [null, { name: 'XYZ' }, m.position.left, m.position.top, null], allowNegativeOffset: true })
    restored = true
    post({ type: 'loaded', pages: viewer.pagesCount })
  })
  eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => post({ type: 'page', page: pageNumber, total: viewer.pagesCount }))
  eventBus.on('pagerendered', ({ source }: { source: PageViewLike }) => drawPage(source, annos, active))
  eventBus.on('updateviewarea', ({ location }: { location: { pageNumber: number; scale: number | string; left: number; top: number } }) => {
    if (!restored) return
    clearTimeout(posTimer)
    posTimer = setTimeout(() => post({ type: 'position', page: location.pageNumber, left: Math.round(location.left), top: Math.round(location.top), scale: 'page-width' }), 600)
  })
  new ResizeObserver(() => {
    const cur = viewer.currentScaleValue
    if (viewer.pagesCount && (cur === 'page-width' || cur === 'auto')) viewer.currentScaleValue = cur
  }).observe(container)

  // —— 选字：Android 长按选中，拖两端的把手调整。选区稳定一会儿再告诉 RN（那边弹出操作面板）——
  let selTimer: ReturnType<typeof setTimeout> | undefined
  let lastSel = ''
  document.addEventListener('selectionchange', () => {
    clearTimeout(selTimer)
    selTimer = setTimeout(() => {
      const sel = document.getSelection()
      const range = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null
      const parts = range ? selectionParts(range, views()) : []
      const key = parts.map((p) => `${p.page}:${p.quote.exact}`).join('|')
      if (key === lastSel) return
      lastSel = key
      post(parts.length ? { type: 'selection', parts, text: parts.map((p) => p.quote.exact).join(' ') } : { type: 'selection', parts: null })
    }, 350)
  })
  // 长按菜单（系统的"复制、全选"）不要：操作面板在 RN 那边
  document.addEventListener('contextmenu', (e) => e.preventDefault())

  // —— 点一下：点在高亮上就选中那条批注，点空白处切换工具栏 ——
  let down: { x: number; y: number; t: number } | null = null
  container.addEventListener('pointerdown', (e) => {
    down = e.isPrimary ? { x: e.clientX, y: e.clientY, t: Date.now() } : null
  })
  container.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10 || Date.now() - down.t > 400) return
    down = null
    if (!document.getSelection()?.isCollapsed) return
    if ((e.target as HTMLElement).closest('a')) return
    const mark = (e.target as HTMLElement).closest<HTMLElement>('.hl-mark')
    if (mark?.dataset['anno']) return post({ type: 'tapAnno', id: mark.dataset['anno'] })
    const v = pageAt(views(), e.clientX, e.clientY)
    if (v) {
      const [x, y] = clientToPdf(v, e.clientX, e.clientY)
      const hit = annos.filter((a) => a.page === v.id - 1 && hitTest(a.target.rects, x, y)).pop()
      if (hit) return post({ type: 'tapAnno', id: hit.id })
    }
    post({ type: 'tap' })
  })

  // —— 双指缩放：手势中用 CSS 缩放预览，松手后按新比例重新渲染 ——
  const inner = document.getElementById('viewer') as HTMLDivElement
  let pinch: { d: number; cx: number; cy: number; ratio: number } | null = null
  const dist = (t: TouchList) => Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY)
  container.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 2) return
      const r = container.getBoundingClientRect()
      const cx = (e.touches[0]!.clientX + e.touches[1]!.clientX) / 2
      const cy = (e.touches[0]!.clientY + e.touches[1]!.clientY) / 2
      pinch = { d: dist(e.touches), cx, cy, ratio: 1 }
      inner.style.transformOrigin = `${cx - r.left + container.scrollLeft}px ${cy - r.top + container.scrollTop}px`
    },
    { passive: true }
  )
  container.addEventListener(
    'touchmove',
    (e) => {
      if (!pinch || e.touches.length !== 2) return
      e.preventDefault()
      const lo = 0.5 / viewer.currentScale
      const hi = 5 / viewer.currentScale
      pinch.ratio = Math.min(hi, Math.max(lo, dist(e.touches) / pinch.d))
      inner.style.transform = `scale(${pinch.ratio})`
    },
    { passive: false }
  )
  const endPinch = () => {
    if (!pinch) return
    const p = pinch
    pinch = null
    inner.style.transform = ''
    if (Math.abs(p.ratio - 1) > 0.02) viewer.updateScale({ scaleFactor: p.ratio, origin: [p.cx, p.cy] })
  }
  container.addEventListener('touchend', (e) => e.touches.length < 2 && endPinch())
  container.addEventListener('touchcancel', endPinch)

  try {
    const doc = await getDocument(docOptions(m.url)).promise
    viewer.setDocument(doc)
    linkService.setDocument(doc)
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}

;(window as unknown as { flaxReader: { receive(m: Msg): void } }).flaxReader = {
  receive(m) {
    switch (m.type) {
      case 'open':
        void open(m)
        break
      case 'annotations':
        annos = m.annotations
        active = m.active
        redraw()
        break
      case 'goto':
        goto(m.page, m.anno, m.quote)
        break
      case 'find':
        find(m)
        break
      case 'closeFind':
        find(null)
        break
      case 'zoom':
        zoom(m.dir)
        break
      case 'dark':
        setDark(m.on)
        break
      case 'facts':
        void facts(m)
        break
      case 'clearSelection':
        document.getSelection()?.removeAllRanges()
        break
    }
  }
}

post({ type: 'ready' })
