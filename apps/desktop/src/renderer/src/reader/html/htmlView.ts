// 网页版阅读器（arXiv 的 HTML 论文）：桌面和手机共用这一份，宿主只负责界面和存数据。
// 批注仍然按 PDF 存（页码、矩形、原文和前后文）：
//   显示：用原文和前后文在网页文字里找到位置（crossAnchor.locate），把那几段字包上 <mark>；
//   新建：网页里选中的字到 PDF 的文字里去找，算出页码和矩形，和在 PDF 上选的一模一样。
// 页码：每一段的开头到 PDF 里找，记下它在第几页、哪一行，翻页、跳页、阅读位置都按它换算。
import { locate, pdfPageOf, quoteAt, rectsOnPage, skeleton, topAt, type Annotation, type PdfText, type Skeleton } from '@flax/core'
import type { SelectionPart } from '../geometry'
import type { OutlineItem } from '../toc'
import { prepareArticle } from './article'
import { buildIndex, nodesIn, toOffset, toRange, type TextIndex } from './textIndex'

export interface HtmlViewOptions {
  /** 滚动的那个元素 */
  scroller: HTMLElement
  /** 正文放在这里面 */
  host: HTMLElement
  /** 存在本机的网页和它所在的文件夹地址 */
  raw: string
  base: string
  pdf: PdfText
  /** 顶上被工具栏挡住的高度：跳转时留出来 */
  topInset?: number
  /** 读到第几页了（从 1 开始） */
  onPage?: (page: number, total: number) => void
  /** 阅读位置，换成 PDF 的页码和那一行的上边缘（PDF 坐标），和 PDF 阅读器存的一样 */
  onPosition?: (p: { page: number; top: number | null }) => void
  /** 外部链接；返回 true 表示宿主处理了（手机交给系统浏览器） */
  onLink?: (url: string) => boolean
  /** 点论文里的链接跳走了（引用、图表、参考文献）/ 回来了：canBack 表示能不能回到跳之前读的地方 */
  onJump?: (canBack: boolean) => void
}

interface Block {
  el: Element
  start: number
  end: number
  /** 在 PDF 的第几页（从 0 开始）；找不到的跟着前一段 */
  page: number
  /** 这一段开头那一行的上边缘（PDF 坐标）；没找到是 null */
  top: number | null
}

const BLOCKS = 'h1, h2, h3, h4, h5, h6, p, figcaption, li, .ltx_bibitem, table.ltx_equation, table.ltx_equationgroup, table.ltx_tabular, .ltx_listing'
const SCALES = [0.8, 0.88, 0.94, 1, 1.07, 1.15, 1.25, 1.36, 1.5]
const FONT_KEY = 'flax.html.font'
const NOTE_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5.5h14v10H10l-4 3.5v-3.5H5z"/></svg>'

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void }
const highlights = (): HighlightRegistry | null => ((globalThis as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights ?? null)
const HighlightCtor = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight

function store(k: string, v?: string): string | null {
  try {
    if (v === undefined) return localStorage.getItem(k)
    localStorage.setItem(k, v)
  } catch {
    /* 存不了就算了 */
  }
  return null
}

export class HtmlView {
  readonly article: HTMLElement
  readonly title: string
  /** 网页的段落有多少能在 PDF 里找到：太低多半不是同一版本 */
  readonly matchRatio: number
  private ix: TextIndex
  private sk: Skeleton
  private blocks: Block[] = []
  private locCache = new Map<string, [number, number][] | null>()
  private page = -1
  /** 最近一次看到的位置：视图被藏起来（切到 PDF 时）量不出位置，就用它 */
  private lastPos: { page: number; top: number | null } | null = null
  /** 点内部链接之前读到的地方：那一段和它离视口顶的距离（按段记，改字号后也回得去）。
   *  连着点好几个链接（引用 → 参考文献 → 另一处）只记第一次的，回去就回到正文读到的地方 */
  private origin: { el: Element; dy: number } | null = null
  private scale: number
  private findQ = ''
  private finds: [number, number][] = []
  private findCur = -1
  private posTimer: ReturnType<typeof setTimeout> | undefined
  private raf = 0
  private flashTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private o: HtmlViewOptions) {
    const { article, title } = prepareArticle(o.raw, o.base)
    this.article = article
    this.title = title
    o.host.replaceChildren(article)
    o.host.classList.add('flax-html')
    this.scale = Number(store(FONT_KEY)) || 1
    o.host.style.setProperty('--fx-scale', String(this.scale))
    this.ix = buildIndex(article)
    this.sk = skeleton(this.ix.text)
    this.matchRatio = this.mapBlocks()
    article.addEventListener('click', this.onClick)
    o.scroller.addEventListener('scroll', this.onScroll, { passive: true })
  }

  destroy(): void {
    clearTimeout(this.posTimer)
    clearTimeout(this.flashTimer)
    cancelAnimationFrame(this.raf)
    this.article.removeEventListener('click', this.onClick)
    this.o.scroller.removeEventListener('scroll', this.onScroll)
    highlights()?.delete('fx-find')
    highlights()?.delete('fx-find-current')
    highlights()?.delete('fx-flash')
    this.o.host.replaceChildren()
    this.o.host.classList.remove('flax-html')
  }

  get pageCount(): number {
    return this.o.pdf.pages.length
  }

  // —— 段落和 PDF 页码 ——

  private mapBlocks(): number {
    const pdf = this.o.pdf
    const psk = pdf.skeleton()
    let cursor = 0
    let probed = 0
    let found = 0
    let page = 0
    for (const el of this.article.querySelectorAll(BLOCKS)) {
      if (el.closest('.ltx_note_outer, .fx-skip')) continue
      const start = toOffset(this.ix, el, 0)
      const end = toOffset(this.ix, el, el.childNodes.length)
      const b: Block = { el, start, end, page, top: null }
      const probe = skeleton(this.ix.text.slice(start, Math.min(end, start + 400))).s.slice(0, 40)
      if (probe.length >= 12) {
        probed++
        // 先往后找（段落大多按顺序），找不到再从头找（浮动的图表在 PDF 里位置会变）
        let at = psk.s.indexOf(probe, Math.max(0, cursor - 3000))
        if (at < 0) at = psk.s.indexOf(probe)
        if (at >= 0) {
          found++
          cursor = at
          const off = psk.map[at]!
          b.page = page = pdfPageOf(pdf, off)
          b.top = topAt(pdf, b.page, off - pdf.pageStart[b.page]!)
        }
      }
      this.blocks.push(b)
    }
    return probed ? found / probed : 0
  }

  /** 视口顶上那一段 */
  private firstVisible(): Block | null {
    const top = this.o.scroller.getBoundingClientRect().top + (this.o.topInset ?? 0) + 4
    let lo = 0
    let hi = this.blocks.length - 1
    let best = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const r = this.blocks[mid]!.el.getBoundingClientRect()
      if (r.bottom > top) {
        best = mid
        hi = mid - 1
      } else lo = mid + 1
    }
    return best >= 0 ? this.blocks[best]! : (this.blocks[this.blocks.length - 1] ?? null)
  }

  private onScroll = () => {
    if (this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.report()
    })
  }

  /** 告诉宿主读到第几页、阅读位置（位置停下来一会儿再报） */
  report(): void {
    if (!this.o.scroller.clientHeight) return
    const b = this.firstVisible()
    if (!b) return
    this.lastPos = this.posOf(b)
    // 自己滚回了跳之前的地方：不用再提示"回去"
    if (this.origin && Math.abs(this.offsetOf(this.origin.el) - this.origin.dy) < this.o.scroller.clientHeight * 0.3) {
      this.origin = null
      this.o.onJump?.(false)
    }
    if (b.page !== this.page) {
      this.page = b.page
      this.o.onPage?.(b.page + 1, this.pageCount)
    }
    clearTimeout(this.posTimer)
    this.posTimer = setTimeout(() => this.o.onPosition?.(this.posOf(b)), 600)
  }

  private posOf(b: Block): { page: number; top: number | null } {
    const i = this.blocks.indexOf(b)
    // 这一段在 PDF 里没找到：用这一页前面最近一段找到的位置，再不行就是这一页的开头
    let top = b.top
    for (let k = i; top === null && k >= 0 && this.blocks[k]!.page === b.page; k--) top = this.blocks[k]!.top
    return { page: b.page + 1, top: top ?? topAt(this.o.pdf, b.page, 0) }
  }

  /** 现在读到的位置（PDF 的页码和那一行的上边缘），切到 PDF 时接着读 */
  position(): { page: number; top: number | null } {
    if (!this.o.scroller.clientHeight) return this.lastPos ?? { page: 1, top: null }
    const b = this.firstVisible()
    return b ? this.posOf(b) : { page: 1, top: null }
  }

  currentPage(): number {
    if (!this.o.scroller.clientHeight) return this.lastPos?.page ?? 1
    return (this.firstVisible()?.page ?? 0) + 1
  }

  private scrollToRect(r: DOMRect, center = false): void {
    const s = this.o.scroller
    const box = s.getBoundingClientRect()
    const inset = this.o.topInset ?? 0
    const y = center ? r.top - box.top - inset - (s.clientHeight - inset) / 2 + r.height / 2 : r.top - box.top - inset - 12
    s.scrollTop += y
  }

  private offsetOf(el: Element): number {
    return el.getBoundingClientRect().top - this.o.scroller.getBoundingClientRect().top
  }

  /** 记下现在读到的地方（拖进度条跳页之前），之后可以 back() 回来；已经记着一处就不换 */
  markOrigin(): void {
    const from = this.firstVisible()
    if (!from || this.origin) return
    this.origin = { el: from.el, dy: this.offsetOf(from.el) }
    this.o.onJump?.(true)
  }

  /** 回到点链接之前读的地方；没有可回的返回 false */
  back(): boolean {
    const o = this.origin
    if (!o) return false
    this.origin = null
    this.o.scroller.scrollTop += this.offsetOf(o.el) - o.dy
    this.o.onJump?.(false)
    return true
  }

  private scrollToEl(el: Element, center = false): void {
    this.scrollToRect(el.getBoundingClientRect(), center)
  }

  /** 跳到 PDF 的第几页（从 1 开始）；top 是 PDF 坐标里那一行的上边缘，能精确到段落 */
  gotoPage(page: number, top: number | null = null): void {
    const p = Math.max(0, Math.min(page - 1, this.pageCount - 1))
    const on = this.blocks.filter((b) => b.page === p)
    let target = on[0] ?? this.blocks.find((b) => b.page >= p) ?? this.blocks[this.blocks.length - 1]
    if (top !== null && on.length) {
      // 视口顶上那一行之下的第一段（PDF 坐标往上是大）
      const below = on.filter((b) => b.top !== null && b.top <= top + 6)
      if (below.length) target = below.reduce((m, b) => (b.top! > m.top! ? b : m))
    }
    if (target) this.scrollToEl(target.el)
    this.report()
  }

  // —— 批注 ——

  private unpaint(): void {
    this.article.querySelectorAll('.fx-note-mark').forEach((el) => el.remove())
    const parents = new Set<Node>()
    this.article.querySelectorAll('mark.fx-hl').forEach((m) => {
      if (m.parentNode) parents.add(m.parentNode)
      m.replaceWith(...m.childNodes)
    })
    parents.forEach((p) => p.normalize())
  }

  private placeOf(a: Annotation): [number, number][] | null {
    const key = `${a.id}\u0000${a.target.quote.prefix}\u0000${a.target.quote.exact}\u0000${a.target.quote.suffix}`
    let loc = this.locCache.get(key)
    if (loc === undefined) {
      loc = locate(this.sk, a.target.quote)?.ranges ?? null
      this.locCache.set(key, loc)
    }
    return loc
  }

  /** 画批注；返回网页里找不到位置的那几条 */
  paint(annos: Annotation[], activeId: string | null): Annotation[] {
    const scroller = this.o.scroller
    const keep = scroller.scrollTop
    this.unpaint()
    this.ix = buildIndex(this.article)
    const unplaced: Annotation[] = []
    const perNode = new Map<Text, { from: number; to: number; a: Annotation }[]>()
    // 后加的在上面（和 PDF 上一样）
    const order = [...annos].sort((x, y) => x.createdAt.localeCompare(y.createdAt))
    for (const a of order) {
      const loc = this.placeOf(a)
      if (!loc) {
        unplaced.push(a)
        continue
      }
      for (const [s, e] of loc) {
        for (const n of nodesIn(this.ix, s, e)) {
          const list = perNode.get(n.node) ?? []
          list.push({ from: n.from, to: n.to, a })
          perNode.set(n.node, list)
        }
      }
    }
    const cls = (a: Annotation) => `fx-hl hl-${a.type} hl-c-${a.color}${a.id === activeId ? ' hl-active' : ''}`
    const mathDone = new Set<Element>()
    for (const [node, list] of perNode) {
      const math = node.parentElement?.closest('math')
      if (math) {
        // 公式里不能插 <mark>：整个公式包起来
        if (mathDone.has(math)) continue
        mathDone.add(math)
        const top = list[list.length - 1]!.a
        const m = document.createElement('mark')
        m.className = cls(top)
        m.dataset['anno'] = top.id
        math.replaceWith(m)
        m.appendChild(math)
        continue
      }
      const cuts = [...new Set([0, node.data.length, ...list.flatMap((x) => [x.from, x.to])])].sort((a, b) => a - b)
      const frag = document.createDocumentFragment()
      for (let i = 0; i + 1 < cuts.length; i++) {
        const a = cuts[i]!
        const b = cuts[i + 1]!
        const piece = node.data.slice(a, b)
        const over = list.filter((x) => x.from <= a && x.to >= b)
        if (!over.length) {
          frag.appendChild(document.createTextNode(piece))
          continue
        }
        const top = over[over.length - 1]!.a
        const m = document.createElement('mark')
        m.className = cls(top)
        m.dataset['anno'] = top.id
        m.textContent = piece
        frag.appendChild(m)
      }
      node.replaceWith(frag)
    }
    // 有评论的：在最后一段字后面放一个小标记
    for (const a of order) {
      if (!a.comment?.trim()) continue
      const marks = this.article.querySelectorAll(`mark.fx-hl[data-anno="${CSS.escape(a.id)}"]`)
      const last = marks[marks.length - 1]
      if (!last) continue
      const icon = document.createElement('span')
      icon.className = `fx-note-mark fx-skip ${a.type === 'note' ? 'hl-q' : `hl-c-${a.color}`}${a.id === activeId ? ' on' : ''}`
      icon.dataset['anno'] = a.id
      icon.title = a.comment.trim().slice(0, 160)
      icon.contentEditable = 'false'
      icon.innerHTML = NOTE_ICON
      last.after(icon)
    }
    this.ix = buildIndex(this.article)
    this.renderFind()
    scroller.scrollTop = keep
    return unplaced
  }

  /** 这个元素上的批注 id */
  annoAt(target: EventTarget | null): string | null {
    const el = (target as Element | null)?.closest?.('[data-anno]') as HTMLElement | null
    return el && this.article.contains(el) ? (el.dataset['anno'] ?? null) : null
  }

  annoAtPoint(x: number, y: number): string | null {
    return this.annoAt(document.elementFromPoint(x, y))
  }

  /** 批注最后一行的框（屏幕坐标），浮层放在它下面 */
  anchorRect(id: string): DOMRect | null {
    const marks = this.article.querySelectorAll(`mark.fx-hl[data-anno="${CSS.escape(id)}"]`)
    const last = marks[marks.length - 1]
    const rects = last?.getClientRects()
    return rects?.length ? rects[rects.length - 1]! : (last?.getBoundingClientRect() ?? null)
  }

  scrollToAnno(id: string): boolean {
    const first = this.article.querySelector(`mark.fx-hl[data-anno="${CSS.escape(id)}"]`)
    if (!first) return false
    this.scrollToEl(first, true)
    return true
  }

  // —— 选中的文字 ——

  private offsets(range: Range): [number, number] | null {
    if (!this.article.contains(range.commonAncestorContainer)) return null
    const s = toOffset(this.ix, range.startContainer, range.startOffset)
    const e = toOffset(this.ix, range.endContainer, range.endOffset)
    return e > s ? [s, e] : null
  }

  /** 选中的字（不带公式的 LaTeX 源码、不带脚注） */
  selectedText(range: Range): string {
    const o = this.offsets(range)
    return o ? this.ix.text.slice(o[0], o[1]).replace(/\s+/g, ' ').trim() : ''
  }

  /** 选中的字在 PDF 上的位置，和在 PDF 上选中时一样按页拆开；PDF 里找不到就是空的 */
  selectionParts(range: Range): SelectionPart[] {
    const o = this.offsets(range)
    if (!o) return []
    const q = quoteAt(this.ix.text, o[0], o[1])
    if (!q.exact) return []
    const pdf = this.o.pdf
    const loc = locate(pdf.skeleton(), q)
    if (!loc) return []
    const parts: SelectionPart[] = []
    for (const [ps, pe] of loc.ranges) {
      for (let p = pdfPageOf(pdf, ps); p <= pdfPageOf(pdf, pe - 1); p++) {
        const at = pdf.pageStart[p]!
        const text = pdf.pages[p]!.text
        const a = Math.max(ps, at) - at
        const b = Math.min(pe, at + text.length) - at
        if (b <= a) continue
        const quote = quoteAt(text, a, b)
        const rects = rectsOnPage(pdf, p, a, b)
        if (quote.exact && rects.length) parts.push({ page: p, rects, quote })
      }
    }
    return parts.sort((x, y) => x.page - y.page)
  }

  // —— 跳到一句话（AI 回答里的引用） ——

  gotoQuote(quote: string, page: number): void {
    const loc = locate(this.sk, { exact: quote, prefix: '', suffix: '' })
    const r = loc?.ranges[0] ? toRange(this.ix, loc.ranges[0][0], loc.ranges[0][1]) : null
    if (!r) return this.gotoPage(page)
    this.scrollToRect(r.getBoundingClientRect(), true)
    const reg = highlights()
    if (reg && HighlightCtor) {
      reg.set('fx-flash', new HighlightCtor(r))
      clearTimeout(this.flashTimer)
      this.flashTimer = setTimeout(() => reg.delete('fx-flash'), 2400)
    }
  }

  // —— 查找 ——

  /** 找 query；again 是找下一个（previous 往回）。返回第几个、一共几个 */
  find(query: string, again = false, previous = false): { current: number; total: number } {
    const q = query.replace(/\s+/g, ' ').trim().toLowerCase()
    if (!q) {
      this.clearFind()
      return { current: 0, total: 0 }
    }
    if (q !== this.findQ) {
      this.findQ = q
      const map: number[] = []
      let flat = ''
      let space = false
      const t = this.ix.text
      for (let i = 0; i < t.length; i++) {
        if (/\s/.test(t[i]!)) {
          space = flat.length > 0
          continue
        }
        if (space) {
          flat += ' '
          map.push(i)
          space = false
        }
        flat += t[i]!.toLowerCase()
        map.push(i)
      }
      this.finds = []
      for (let at = flat.indexOf(q); at !== -1 && this.finds.length < 2000; at = flat.indexOf(q, at + 1)) this.finds.push([map[at]!, map[at + q.length - 1]! + 1])
      // 从现在读到的地方往后找第一个
      const from = this.firstVisible()?.start ?? 0
      const next = this.finds.findIndex(([s]) => s >= from)
      this.findCur = this.finds.length ? (next >= 0 ? next : 0) : -1
    } else if (again && this.finds.length) {
      this.findCur = (this.findCur + (previous ? -1 : 1) + this.finds.length) % this.finds.length
    }
    this.renderFind(true)
    return { current: this.findCur + 1, total: this.finds.length }
  }

  private renderFind(scroll = false): void {
    const reg = highlights()
    if (!this.findQ || !this.finds.length) {
      reg?.delete('fx-find')
      reg?.delete('fx-find-current')
      return
    }
    const ranges = this.finds.map(([s, e]) => toRange(this.ix, s, e)).filter((r): r is Range => !!r)
    const cur = this.finds[this.findCur] ? toRange(this.ix, this.finds[this.findCur]![0], this.finds[this.findCur]![1]) : null
    if (reg && HighlightCtor) {
      reg.set('fx-find', new HighlightCtor(...ranges))
      if (cur) reg.set('fx-find-current', new HighlightCtor(cur))
    }
    if (scroll && cur) this.scrollToRect(cur.getBoundingClientRect(), true)
  }

  clearFind(): void {
    this.findQ = ''
    this.finds = []
    this.findCur = -1
    this.renderFind()
  }

  // —— 字号 ——

  /** 放大、缩小一档；0 回到默认。返回现在的比例 */
  zoom(dir: 1 | -1 | 0): number {
    const anchor = this.firstVisible()
    const before = anchor?.el.getBoundingClientRect().top ?? 0
    const i = SCALES.indexOf(this.scale)
    const cur = i >= 0 ? i : SCALES.indexOf(1)
    this.scale = dir === 0 ? 1 : SCALES[Math.max(0, Math.min(SCALES.length - 1, cur + dir))]!
    store(FONT_KEY, String(this.scale))
    this.o.host.style.setProperty('--fx-scale', String(this.scale))
    // 字变大小后，原来顶上那一段还留在原处
    if (anchor) this.o.scroller.scrollTop += anchor.el.getBoundingClientRect().top - before
    return this.scale
  }

  get fontScale(): number {
    return this.scale
  }

  // —— 目录 ——

  outline(): OutlineItem[] {
    const out: OutlineItem[] = []
    const stack: { raw: number; item: OutlineItem }[] = []
    let id = 0
    for (const h of this.article.querySelectorAll('h2.ltx_title, h3.ltx_title, h4.ltx_title, h5.ltx_title')) {
      if (h.closest('.ltx_note_outer')) continue
      const title = (h.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (!title) continue
      const raw = Number(h.tagName[1])
      while (stack.length && stack[stack.length - 1]!.raw >= raw) stack.pop()
      const parent = stack[stack.length - 1]?.item
      if (parent) parent.hasKids = true
      const block = this.blocks.find((b) => b.el === h)
      const item: OutlineItem = { id: id++, title, level: stack.length, parent: parent?.id ?? -1, hasKids: false, page: (block?.page ?? 0) + 1, dest: h }
      out.push(item)
      stack.push({ raw, item })
    }
    return out
  }

  gotoOutline(it: OutlineItem): void {
    if (it.dest instanceof Element && this.article.contains(it.dest)) this.scrollToEl(it.dest)
    else if (it.page) this.gotoPage(it.page)
    this.report()
  }

  // —— 点击：页内跳转、脚注、外部链接 ——

  private onClick = (e: MouseEvent) => {
    const t = e.target as Element
    const note = t.closest('.ltx_note')
    if (note && !t.closest('.ltx_note_outer')) {
      e.preventDefault()
      note.classList.toggle('fx-open')
      return
    }
    const a = t.closest('a[href]') as HTMLAnchorElement | null
    if (!a) return
    const href = a.getAttribute('href') ?? ''
    if (href.startsWith('#')) {
      e.preventDefault()
      const el = this.article.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)
      if (el) {
        const from = this.firstVisible()
        if (from && !this.origin) {
          this.origin = { el: from.el, dy: this.offsetOf(from.el) }
          this.o.onJump?.(true)
        }
        this.scrollToEl(el)
        el.classList.add('fx-target')
        setTimeout(() => el.classList.remove('fx-target'), 1600)
      }
      return
    }
    if (this.o.onLink?.(href)) e.preventDefault()
  }
}
