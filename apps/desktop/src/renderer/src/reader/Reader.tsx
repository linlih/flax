// 阅读器：PDF.js 的 PDFViewer 负责渲染、文字层、链接、查找；
// 我们在上面加高亮层、选中文字的工具条、批注卡片、缩略图和批注列表。
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
// 必须在 pdf_viewer.mjs 之前：它加载时要用 globalThis.pdfjsLib
import { loadDocument } from './pdf'
import 'pdfjs-dist/web/pdf_viewer.css'
import { EventBus, FindState, LinkTarget, PDFFindController, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { quoteBlock, type Annotation, type HighlightColor, type Paper, type ReadingPosition, type ReadingStatus, type Term } from '@flax/core'
import type { NoteSummary } from '../../../shared/api'
import { NoteEditor, type EditorHandle } from '../components/NoteEditor'
import { Icon, Spinner } from '../components/Icon'
import type { Toast } from '../components/Notices'
import { api } from '../lib/library'
import { clientToPdf, hitTest, pageAt, rectToPercent, selectionParts, type PageViewLike, type SelectionPart } from './geometry'
import { drawPage } from './overlay'
import { Thumbnails } from './Thumbnails'
import { parseHash, renderPreview, resolveTarget } from './linkPreview'
import { AiPanel } from './AiPanel'
import { AnnoList } from './AnnoList'
import { COLORS } from './colors'
import { TranslateCard } from './TranslateCard'
import { ReaderToolbar, type Tool } from './ReaderToolbar'
import { useAiStatus } from '../lib/ai'
import { composing, FOCUS_KEY, isMac, kbd, mod } from '../lib/platform'
import { nearEnd } from '../lib/status'


/** 当前外观是不是深色；外观由整个应用统一切换（见 main/appearance.ts），这里只跟着变 */
/** 缩略图栏的宽度（和 styles.css 的 .thumbs 一致）、论文那一块至少留多宽 */
const THUMBS_W = 148
const MIN_STAGE_W = 460

function useWindowWidth(): number {
  const [w, setW] = useState(() => window.innerWidth)
  useEffect(() => {
    const on = () => setW(window.innerWidth)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return w
}

function useDark(): boolean {
  const mq = useMemo(() => window.matchMedia('(prefers-color-scheme: dark)'), [])
  const [dark, setDark] = useState(mq.matches)
  useEffect(() => {
    const on = () => setDark(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [mq])
  return dark
}

interface Props {
  paper: Paper
  backLabel: string
  onBack: () => void
  /** 看这篇的详情：标题、作者、标签、文件 */
  onInfo: () => void
  toast: (t: Omit<Toast, 'key'>) => void
  notes: NoteSummary[]
  /** 打开后跳到这条批注（从笔记里的引用块点过来）；n 变了就再跳一次 */
  jump?: { id: string; n: number }
  onOpenNoteTitle: (title: string) => void
  onOpenAnnotation: (id: string) => void
  onOpenSettings: () => void
  /** 术语表，翻译卡片用来认出已经定过译法的词 */
  terms: Term[]
  /** 重新选了 PDF：整个阅读器重新加载 */
  onReloadFile: () => void
  /** 手动改阅读状态（读到最后点"标为读过"），可以撤销 */
  onStatus: (st: ReadingStatus) => void
}

/** 开着这么久，或者翻过第一页，才算"在读"：打开看一眼不算 */
const READING_AFTER_MS = 30_000

const MISSING = '找不到这篇论文的 PDF 文件，可能被从资料文件夹里移走或删掉了。'

/** 浮层的位置：滚动容器内容里的坐标，跟着页面一起滚 */
interface Spot {
  x: number
  y: number
}

const pref = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(`reader.${k}`)
    } catch {
      return null
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(`reader.${k}`, v)
    } catch {
      /* 存不了就算了，下次用默认值 */
    }
  }
}

export function Reader({ paper, backLabel, onBack, onInfo, toast, notes, jump, onOpenNoteTitle, onOpenAnnotation, onOpenSettings, terms, onReloadFile, onStatus }: Props) {
  const file = paper.files.find((f) => f.role === 'main') ?? paper.files[0]!
  const hash = file.hash
  const scrollRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<HTMLDivElement>(null)
  const pdfViewer = useRef<PDFViewer | null>(null)
  const bus = useRef<EventBus | null>(null)

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  /** 页面排好、阅读位置恢复完之后才为 true；从笔记跳过来要等它 */
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  // 未读、待读的论文真读起来了就变成在读（不弹提示，这是自动的）
  const notStarted = paper.readingStatus === 'inbox' || paper.readingStatus === 'to_read'
  useEffect(() => {
    if (!notStarted) return
    const start = () => void api.library.update(paper.id, { readingStatus: 'reading' })
    if (page > 1) return start()
    const t = setTimeout(start, READING_AFTER_MS)
    return () => clearTimeout(t)
  }, [notStarted, page > 1, paper.id])
  const [pageInput, setPageInput] = useState('1')
  const [scale, setScale] = useState<{ value: number; preset: string | null }>({ value: 1, preset: 'auto' })

  const [annos, setAnnos] = useState<Annotation[]>([])
  const annosRef = useRef(annos)
  annosRef.current = annos
  /** 选中的批注。from 'list'：在侧栏列表里点的，就在列表里展开编辑，不弹页面上的卡片 */
  const [active, setActive] = useState<{ id: string; at: Spot; focus?: boolean; from?: 'list' } | null>(null)
  const activeRef = useRef<string | null>(null)
  activeRef.current = active?.id ?? null
  const [selBar, setSelBar] = useState<{ at: Spot; parts: SelectionPart[]; text: string } | null>(null)
  const [lastColor, setLastColor] = useState<HighlightColor>(() => (pref.get('color') as HighlightColor) ?? 'yellow')
  /** 右键菜单：在选中的文字上（bar），或者在已有的高亮上（anno） */
  const [ctx, setCtx] = useState<{ at: Spot; text: string; bar?: NonNullable<typeof selBar>; anno?: Annotation } | null>(null)
  const aiStatus = useAiStatus()
  /** 右键"翻译"弹出的译文卡片 */
  const [trans, setTrans] = useState<{ at: Spot; text: string } | null>(null)

  const [showThumbs, setShowThumbs] = useState(() => pref.get('thumbs') !== '0')
  const [showPanel, setShowPanel] = useState(() => pref.get('panel') !== '0')
  /** 当前工具（底部工具栏）：每次打开论文都从"选择文字"开始，跟 Figma 一样 */
  const [tool, setTool] = useState<Tool>('select')
  /** 按住空格：临时变抓手 */
  const [spaceHand, setSpaceHand] = useState(false)
  const hand = tool === 'hand' || spaceHand
  const [panning, setPanning] = useState(false)
  /** 刚拖过页面：这次松开鼠标不算点击；空格按住期间拖过就不翻页 */
  const dragged = useRef(false)
  const spaceDragged = useRef(false)
  /** 空格是不是正按着（事件处理里要读最新值，不能用 state） */
  const spaceDown = useRef(false)
  /** 全屏阅读：窗口全屏，两边的栏都收起来，只留论文 */
  const [focus, setFocus] = useState(false)
  useEffect(() => {
    const on = () => setFocus(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', on)
    return () => {
      document.removeEventListener('fullscreenchange', on)
      if (document.fullscreenElement) void document.exitFullscreen()
    }
  }, [])
  const toggleFocus = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen().catch(() => setFocus((f) => !f))
  }
  const dark = useDark()
  /** 工具栏的"更多"菜单：不常用的两项（论文详情、深色 / 浅色）收在里面 */
  const [more, setMore] = useState(false)
  useEffect(() => {
    if (!more) return
    const away = (e: PointerEvent) => !(e.target as HTMLElement).closest?.('.reader-more') && setMore(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMore(false)
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', esc)
    }
  }, [more])

  const [find, setFind] = useState<{ open: boolean; query: string; current: number; total: number; state: number | null }>({ open: false, query: '', current: 0, total: 0, state: null })
  const findInput = useRef<HTMLInputElement>(null)

  const views = useCallback((): PageViewLike[] => {
    const v = pdfViewer.current
    if (!v) return []
    const out: PageViewLike[] = []
    for (let i = 0; i < v.pagesCount; i++) {
      const pv = v.getPageView(i) as PageViewLike | undefined
      if (pv?.div) out.push(pv)
    }
    return out
  }, [])

  const reload = useCallback(async () => setAnnos(await api.library.annotations(paper.id)), [paper.id])

  // —— 打开文档 ——
  useEffect(() => {
    const container = scrollRef.current!
    const t0 = performance.now()
    let firstPaint = false
    const eventBus = new EventBus()
    const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK })
    const findController = new PDFFindController({ eventBus, linkService })
    const viewer = new PDFViewer({ container, viewer: viewerRef.current!, eventBus, linkService, findController })
    linkService.setViewer(viewer)
    pdfViewer.current = viewer
    bus.current = eventBus

    const saved = paper.readingPosition?.fileHash === hash ? paper.readingPosition : undefined
    let restored = false
    /** 关闭时 PDF.js 还会发一次视图变化，不能把它存成阅读位置 */
    let closed = false
    let pending: ReadingPosition | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let last: ReadingPosition | null = null
    const flush = (final = false) => {
      clearTimeout(timer)
      const pos = pending ?? (final ? last : null)
      if (pos) void api.library.savePosition(paper.id, pos, final)
      pending = null
    }

    eventBus.on('pagesinit', () => {
      viewer.currentScaleValue = saved?.scale ?? 'auto'
      if (saved) {
        viewer.scrollPageIntoView({ pageNumber: Math.min(saved.page, viewer.pagesCount), destArray: [null, { name: 'XYZ' }, saved.left, saved.top, null], allowNegativeOffset: true })
      }
      restored = true
      container.focus({ preventScroll: true })
      setReady(true)
      // 别的设备上读得更靠后（或更晚读过别的页）：提示一下，点了才跳，不自己跳
      void api.library.positionElsewhere(paper.id).then((o) => {
        if (closed || !o || o.fileHash !== hash || o.page === (saved?.page ?? 1) || o.page > viewer.pagesCount) return
        toast({ text: `在 ${o.device} 上读到第 ${o.page} 页`, group: 'elsewhere', action: { label: '跳过去', run: () => viewer.scrollPageIntoView({ pageNumber: o.page }) } })
      })
    })
    eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => {
      setPage(pageNumber)
      setPageInput(String(pageNumber))
    })
    eventBus.on('scalechanging', ({ scale: s, presetValue }: { scale: number; presetValue?: string }) => {
      setScale({ value: s, preset: presetValue ?? null })
      setActive(null)
      setSelBar(null)
    })
    eventBus.on('pagerendered', ({ source }: { source: PageViewLike }) => {
      drawPage(source, annosRef.current, activeRef.current)
      if (!firstPaint) {
        firstPaint = true
        ;(window as unknown as { __readerFirstPaintMs?: number }).__readerFirstPaintMs = Math.round(performance.now() - t0)
      }
    })
    eventBus.on('updateviewarea', ({ location }: { location: { pageNumber: number; scale: number | string; left: number; top: number } }) => {
      if (!restored || closed) return
      const sc = typeof location.scale === 'number' ? String(location.scale / 100) : location.scale
      pending = { fileHash: hash, page: location.pageNumber, left: Math.round(location.left), top: Math.round(location.top), scale: sc, updatedAt: new Date().toISOString() }
      last = pending
      clearTimeout(timer)
      timer = setTimeout(() => flush(), 800)
    })
    eventBus.on('updatefindmatchescount', ({ matchesCount }: { matchesCount: { current: number; total: number } }) => setFind((f) => ({ ...f, ...matchesCount })))
    eventBus.on('updatefindcontrolstate', ({ state, matchesCount }: { state: number; matchesCount: { current: number; total: number } }) => setFind((f) => ({ ...f, state, ...matchesCount })))

    // 窗口或两边栏宽度变了：预设缩放（自动、适合宽度）重新算
    const ro = new ResizeObserver(() => {
      const cur = viewer.currentScaleValue
      if (viewer.pagesCount && (cur === 'auto' || cur === 'page-width' || cur === 'page-fit')) viewer.currentScaleValue = cur
    })
    ro.observe(container)

    // Ctrl / ⌘ + 滚轮缩放，以鼠标位置为中心；触控板双指捏合也是这个事件（带 ctrlKey）。
    // 鼠标滚轮一格按一档缩放；触控板的小幅连续变化按比例缩放，攒够 1% 再应用（PDF.js 按 1% 取整）
    let want = 0
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !viewer.pagesCount) return
      e.preventDefault()
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
      const origin = [e.clientX, e.clientY]
      if (Math.abs(dy) >= 50) {
        want = 0
        viewer.updateScale({ steps: dy < 0 ? 1 : -1, origin, drawingDelay: 200 })
        return
      }
      const cur = viewer.currentScale
      want = Math.min(10, Math.max(0.1, (want || cur) * Math.exp(-dy * 0.01)))
      if (Math.abs(want - cur) >= 0.01) {
        viewer.updateScale({ scaleFactor: want / cur, origin, drawingDelay: 200 })
        want = viewer.currentScale === cur ? want : 0
      }
    }
    container.addEventListener('wheel', onWheel, { passive: false })

    const task = loadDocument(hash)
    let alive = true
    task.promise.then(
      (pdf) => {
        if (!alive) return
        viewer.setDocument(pdf)
        linkService.setDocument(pdf)
        setDoc(pdf)
      },
      (e: unknown) => {
        if (!alive) return
        const name = (e as { name?: string }).name
        void api.library.fileMissing(paper.id).then((missing) => {
          if (!alive) return
          if (missing) return setError(MISSING)
          setError(name === 'PasswordException' ? '这个 PDF 设了密码，暂时打不开。' : name === 'InvalidPDFException' ? '文件已损坏，不是有效的 PDF。' : `打不开这个 PDF：${e instanceof Error ? e.message : String(e)}`)
        })
      }
    )
    void api.library.markOpened(paper.id)
    void reload()
    return () => {
      alive = false
      closed = true
      ro.disconnect()
      container.removeEventListener('wheel', onWheel)
      flush(true)
      viewer.setDocument(null as unknown as PDFDocumentProxy)
      task.destroy()
      pdfViewer.current = null
      bus.current = null
    }
    // 只在换文件时重新打开；paper 的其它变化不需要
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash])

  // 批注或选中的批注变了：重画已经渲染的页面
  useEffect(() => {
    for (const v of views()) drawPage(v, annos, active?.id ?? null)
  }, [annos, active?.id, views])

  // —— 浮层位置 ——
  // —— 引用悬停预览：停 300ms 才出现，移开就消失 ——
  const [peek, setPeek] = useState<{ at: Spot; src: string; w: number; h: number; page: number; above: boolean } | null>(null)
  const peekLink = useRef<Element | null>(null)
  const peekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const onLinkOver = (e: React.MouseEvent) => {
    const a = (e.target as Element).closest?.('.annotationLayer a[href^="#"]')
    if (!a || a === peekLink.current || !doc) return
    peekLink.current = a
    clearTimeout(peekTimer.current)
    peekTimer.current = setTimeout(async () => {
      const dest = parseHash(a.getAttribute('href') ?? '')
      const t = dest && (await resolveTarget(doc, dest).catch(() => null))
      if (!t || peekLink.current !== a) return
      const { canvas, cssWidth, cssHeight } = await renderPreview(doc, t)
      if (peekLink.current !== a) return
      const r = a.getBoundingClientRect()
      const box = scrollRef.current!
      const stage = box.getBoundingClientRect()
      // 下方放不下就放到链接上方；左右都留在可见区域里（不算滚动条）
      const above = r.bottom + cssHeight + 60 > stage.top + box.clientHeight
      const outer = cssWidth + 14
      const x = Math.min(Math.max(r.left, stage.left + 8), stage.left + box.clientWidth - outer - 8)
      setPeek({ at: toSpot(x, above ? r.top : r.bottom), src: canvas.toDataURL(), w: cssWidth, h: cssHeight, page: t.pageIndex + 1, above })
    }, 300)
  }
  const onLinkOut = (e: React.MouseEvent) => {
    if (!peekLink.current) return
    const to = e.relatedTarget as Node | null
    if (to && peekLink.current.contains(to)) return
    peekLink.current = null
    clearTimeout(peekTimer.current)
    setPeek(null)
  }
  useEffect(() => () => clearTimeout(peekTimer.current), [])

  const toSpot = (clientX: number, clientY: number): Spot => {
    const c = scrollRef.current!
    const r = c.getBoundingClientRect()
    return { x: clientX - r.left + c.scrollLeft, y: clientY - r.top + c.scrollTop }
  }
  /** 批注最后一行的下边缘，浮层放在这里 */
  const spotFor = (a: Annotation): Spot | null => {
    const v = views().find((x) => x.id === a.page + 1)
    const last = a.target.rects[a.target.rects.length - 1]
    if (!v || !last) return null
    const p = rectToPercent(v, last)
    const box = v.div.getBoundingClientRect()
    return toSpot(box.left + ((p.left + p.width / 2) / 100) * box.width, box.top + ((p.top + p.height) / 100) * box.height)
  }

  // —— 选中文字、点击高亮 ——
  /** 这个位置上的批注（后画的在上面） */
  const annoAt = (clientX: number, clientY: number): Annotation | undefined => {
    const v = pageAt(views(), clientX, clientY)
    if (!v) return undefined
    const [x, y] = clientToPdf(v, clientX, clientY)
    return [...annosRef.current].reverse().find((a) => a.page === v.id - 1 && hitTest(a.target.rects, x, y))
  }

  const onPointerUp = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.reader-float, .reader-toolbar') || e.button !== 0) return
    setCtx(null)
    // 页边的评论标记：打开这条批注
    const mark = (e.target as HTMLElement).closest<HTMLElement>('.hl-mark')
    const marked = mark && annosRef.current.find((a) => a.id === mark.dataset['anno'])
    if (marked && !dragged.current) {
      setSelBar(null)
      setActive(activeRef.current === marked.id ? null : { id: marked.id, at: spotFor(marked) ?? toSpot(e.clientX, e.clientY) })
      return
    }
    if (dragged.current) return
    // 抓手：点一下（没拖）照样能打开高亮的批注，点空白处收起
    if (hand) {
      const hit = annoAt(e.clientX, e.clientY)
      setActive(hit ? { id: hit.id, at: spotFor(hit) ?? toSpot(e.clientX, e.clientY) } : null)
      return
    }
    // 等浏览器把选区定下来
    requestAnimationFrame(() => {
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed && sel.rangeCount && scrollRef.current?.contains(sel.anchorNode)) {
        const range = sel.getRangeAt(0)
        const parts = selectionParts(range, views())
        const rects = range.getClientRects()
        const last = rects[rects.length - 1]
        if (parts.length && last) {
          setActive(null)
          const bar = { at: toSpot(last.right, last.bottom), parts, text: sel.toString() }
          // 高亮、下划线工具：选中就直接标上；选择工具只是选中，要做什么在右键菜单里
          if (tool === 'highlight' || tool === 'underline') return void create(tool, lastColor, false, bar)
          setSelBar(bar)
          return
        }
      }
      setSelBar(null)
      const hit = annoAt(e.clientX, e.clientY)
      if (hit) setActive({ id: hit.id, at: spotFor(hit) ?? toSpot(e.clientX, e.clientY) })
      else setActive(null)
    })
  }

  /**
   * 双击一个词：翻译设好了就直接翻。选区留着，右键照样能批注。
   * 抓手工具（或按住空格）下按下去不会选字，但双击不会拖动页面，所以自己选中鼠标下的词再翻
   */
  const onDoubleClick = (e: React.MouseEvent) => {
    if (!aiStatus?.translate.ready) return
    if (hand) {
      if (!dragged.current && selectWordAt(e.clientX, e.clientY, scrollRef.current)) translateSelection()
      return
    }
    if (tool !== 'select') return
    requestAnimationFrame(translateSelection)
  }
  const translateSelection = () => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount || !scrollRef.current?.contains(sel.anchorNode)) return
    const word = sel.toString().trim()
    if (!word || word.length > 60 || /\s/.test(word)) return
    const rects = sel.getRangeAt(0).getClientRects()
    const first = rects[0]
    const last = rects[rects.length - 1]
    if (first && last) translate(word, toSpot((first.left + last.right) / 2, last.bottom))
  }

  const create = async (type: Annotation['type'], color: HighlightColor, withComment = false, bar = selBar): Promise<Annotation[]> => {
    if (!bar) return []
    const made: Annotation[] = []
    for (const part of bar.parts) {
      made.push(await api.library.addAnnotation({ paperId: paper.id, fileHash: hash, type, origin: 'select', color, page: part.page, target: { rects: part.rects, quote: part.quote } }))
    }
    window.getSelection()?.removeAllRanges()
    setSelBar(null)
    setLastColor(color)
    pref.set('color', color)
    await reload()
    const first = made[0]
    if (withComment && first) setActive({ id: first.id, at: spotFor(first) ?? bar.at, focus: true })
    return made
  }

  /** 拿选中的文字问 AI：挂到 AI 标签的输入框上。只发这段文字，不发论文 */
  /** 浮层以 at 为中心、半宽 half；别让它伸出可见区域 */
  const inView = (at: Spot, half: number): Spot => {
    const el = scrollRef.current
    if (!el) return at
    return { ...at, x: Math.min(Math.max(at.x, el.scrollLeft + half + 8), el.scrollLeft + el.clientWidth - half - 8) }
  }
  const closeTrans = useCallback(() => setTrans(null), [])
  const relink = async () => {
    const r = await api.library.relink(paper.id)
    if (r === 'not_pdf') toast({ text: '选的文件不是有效的 PDF' })
    if (r === 'other_paper') toast({ text: '这个文件属于库里的另一篇论文' })
    if (r === 'ok') onReloadFile()
  }

  const translate = (text: string, at: Spot) => {
    setCtx(null)
    setActive(null)
    setTrans({ at: inView(at, 170), text: text.trim() })
  }

  const askAi = (text: string) => {
    setAiQuote((q) => ({ text: text.replace(/\s+/g, ' ').trim(), n: (q?.n ?? 0) + 1 }))
    window.getSelection()?.removeAllRanges()
    setSelBar(null)
    setCtx(null)
    if (focus) toggleFocus()
    openAi()
  }

  const chooseTool = (t: Tool) => {
    setTool(t)
    window.getSelection()?.removeAllRanges()
    setSelBar(null)
    setCtx(null)
  }

  const pickColor = (c: HighlightColor) => {
    setLastColor(c)
    pref.set('color', c)
  }

  /** 拖动页面：抓手工具或按住空格时用左键，任何工具下都可以按住中键拖。链接和浮层照常点 */
  /**
   * 从一个字母上按下开始拖，选区就从这个字母算起。浏览器按字母中线算：按在右半边就从下一个字母开始，
   * 而 "t"、"l" 这种窄字母只有几个像素宽，常常按到右半边，摘出来就少了开头一个字母。
   * 拖的过程中一直把起点固定在按下的那个字母前，选区跟着鼠标走，松手时不会再变。
   */
  const pinSelectionStart = (e: React.PointerEvent) => {
    if (e.button !== 0 || e.shiftKey || hand || !(e.target as HTMLElement).closest('.textLayer')) return
    const pos = document.caretPositionFromPoint?.(e.clientX, e.clientY)
    const node = pos?.offsetNode
    if (!node || node.nodeType !== Node.TEXT_NODE || pos.offset < 1) return
    const ch = document.createRange()
    ch.setStart(node, pos.offset - 1)
    ch.setEnd(node, pos.offset)
    const box = ch.getBoundingClientRect()
    // 只管按在前一个字母右半边的情况；按在字母之间的空白不动
    if (!/\S/.test(ch.toString()) || e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) return
    const at = pos.offset
    const fix = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.anchorNode !== node || sel.anchorOffset !== at || !sel.focusNode) return
      // 往左拖时起点在右边，那个字母本来就在选区里
      if (sel.anchorNode.compareDocumentPosition(sel.focusNode) & Node.DOCUMENT_POSITION_PRECEDING) return
      if (sel.focusNode === node && sel.focusOffset < at) return
      sel.setBaseAndExtent(node, at - 1, sel.focusNode, sel.focusOffset)
    }
    const up = () => {
      fix()
      document.removeEventListener('selectionchange', fix)
      window.removeEventListener('pointerup', up, true)
    }
    document.addEventListener('selectionchange', fix)
    window.addEventListener('pointerup', up, true)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    dragged.current = false
    // 点页边的评论标记不开始选字
    if (e.button === 0 && !hand && (e.target as HTMLElement).closest('.hl-mark')) return void e.preventDefault()
    if (tool !== 'hand') pinSelectionStart(e)
    const left = e.button === 0 && hand && !(e.target as HTMLElement).closest('.reader-float, a')
    if (!left && e.button !== 1) return
    // 抓手下双击选中的词，再按下去时清掉
    if (left) window.getSelection()?.removeAllRanges()
    const c = scrollRef.current
    if (!c) return
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY, left: c.scrollLeft, top: c.scrollTop }
    setPanning(true)
    const move = (m: PointerEvent) => {
      const dx = m.clientX - start.x
      const dy = m.clientY - start.y
      if (Math.abs(dx) + Math.abs(dy) > 3) dragged.current = spaceDragged.current = true
      c.scrollLeft = start.left - dx
      c.scrollTop = start.top - dy
    }
    const up = () => {
      setPanning(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setTimeout(() => (dragged.current = false))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** 选中的文字上右键：问 AI、复制 */
  const onContextMenu = (e: React.MouseEvent) => {
    const at = toSpot(e.clientX, e.clientY)
    const sel = window.getSelection()
    const text = sel && !sel.isCollapsed && sel.rangeCount && scrollRef.current?.contains(sel.anchorNode) ? sel.toString().trim() : ''
    if (text) {
      e.preventDefault()
      const parts = selectionParts(sel!.getRangeAt(0), views())
      setCtx({ at, text, bar: parts.length ? { at, parts, text } : undefined })
      return
    }
    const hit = annoAt(e.clientX, e.clientY)
    if (!hit) return
    e.preventDefault()
    setActive(null)
    setCtx({ at, text: hit.target.quote.exact, anno: hit })
  }

  /** 跳到原文：先翻到那一页，再用 PDF.js 的查找把那句话找出来高亮（从当前页开始找） */
  const citeJump = (pageNumber: number, quote: string) => {
    const v = pdfViewer.current
    if (!v) return
    v.currentPageNumber = Math.min(Math.max(1, pageNumber), v.pagesCount)
    const words = quote.replace(/\s+/g, ' ').trim().split(' ')
    // 太长的句子只找开头几个词，跨行、连字符更容易对上；中文按字数截
    const q = /[\u3400-\u9fff]/.test(quote) ? quote.replace(/\s+/g, '').slice(0, 24) : words.slice(0, 10).join(' ')
    if (q) bus.current?.dispatch('find', { source: null, type: '', query: q, caseSensitive: false, entireWord: false, highlightAll: false, findPrevious: false, matchDiacritics: false })
  }

  const update = async (id: string, patch: Parameters<typeof api.library.updateAnnotation>[1]) => {
    await api.library.updateAnnotation(id, patch)
    await reload()
  }
  /** 换颜色：只写了评论的（note）选了颜色就变成高亮 */
  const recolor = (a: Annotation, color: HighlightColor) => void update(a.id, a.type === 'note' ? { color, type: 'highlight' } : { color })

  // 只写评论的批注，评论框关掉时还是空的：当没加过，悄悄删掉（不然页面上留一条看不出意思的虚线）
  const prevActive = useRef<string | null>(null)
  useEffect(() => {
    const was = prevActive.current
    prevActive.current = active?.id ?? null
    if (!was || was === active?.id) return
    if (annosRef.current.find((x) => x.id === was)?.type !== 'note') return
    // 刚写的评论可能还在保存：重新读一次（保存的请求先发，主进程按顺序处理）
    void api.library.annotations(paper.id).then((list) => {
      const a = list.find((x) => x.id === was)
      if (a && !a.comment?.trim()) void api.library.removeAnnotation(a.id).then(reload)
    })
  }, [active?.id, reload, paper.id])

  const remove = async (a: Annotation) => {
    await api.library.removeAnnotation(a.id)
    setActive(null)
    await reload()
    toast({ text: '已删除批注', action: { label: '撤销', run: () => void api.library.restoreAnnotation(a.id).then(reload) } })
  }

  const jumpTo = (a: Annotation, open = true) => {
    const v = pdfViewer.current
    const r = a.target.rects[0]
    if (!v || !r) return
    v.scrollPageIntoView({ pageNumber: a.page + 1, destArray: [null, { name: 'XYZ' }, null, Math.max(r[1], r[3]) + 60, null], allowNegativeOffset: true })
    if (open) requestAnimationFrame(() => setActive({ id: a.id, at: spotFor(a) ?? { x: 0, y: 0 } }))
  }

  const goPage = (n: number) => {
    const v = pdfViewer.current
    if (!v || !Number.isFinite(n)) return
    v.currentPageNumber = Math.min(Math.max(1, Math.round(n)), v.pagesCount)
  }

  // —— 查找 ——
  const runFind = (query: string, again = false, previous = false) => {
    bus.current?.dispatch('find', { source: null, type: again ? 'again' : '', query, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: previous, matchDiacritics: false })
  }
  const openFind = () => {
    setFind((f) => ({ ...f, open: true }))
    requestAnimationFrame(() => findInput.current?.select())
  }
  const closeFind = () => {
    bus.current?.dispatch('findbarclose', { source: null })
    setFind((f) => ({ ...f, open: false, current: 0, total: 0, state: null }))
    scrollRef.current?.focus({ preventScroll: true })
  }

  // —— 缩放 ——
  const zoom = (dir: 1 | -1 | 0) => {
    const v = pdfViewer.current
    if (!v) return
    if (dir === 0) v.currentScaleValue = 'auto'
    else if (dir > 0) v.increaseScale()
    else v.decreaseScale()
  }

  // —— 键盘 ——
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest?.('input, textarea')
      // 在笔记编辑器里打字时，快捷键归编辑器（⌘F 查找、⌘[ 减少缩进…）
      if ((e.target as HTMLElement).closest?.('.cm-editor')) return
      if (e.code === 'KeyF' && (isMac ? e.metaKey && e.ctrlKey : e.ctrlKey && e.shiftKey)) return e.preventDefault(), toggleFocus()
      if (mod(e) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        return openFind()
      }
      if (mod(e) && (e.key === '=' || e.key === '+')) return e.preventDefault(), zoom(1)
      if (mod(e) && e.key === '-') return e.preventDefault(), zoom(-1)
      if (mod(e) && e.key === '0') return e.preventDefault(), zoom(0)
      if (mod(e) && e.key === '[') return e.preventDefault(), onBack()
      if (mod(e) && e.altKey && e.code === 'KeyS') return e.preventDefault(), togglePref('thumbs', !showThumbs, setShowThumbs)
      if (e.key === 'Escape') {
        if (ctx) return setCtx(null)
        if (selBar) {
          window.getSelection()?.removeAllRanges()
          return setSelBar(null)
        }
        if (active) return setActive(null)
        if (find.open) return closeFind()
        if (tool !== 'select') return chooseTool('select')
        if (focus) return toggleFocus()
        return
      }
      // 按住空格临时变抓手；没拖就松开，照常翻一屏（⇧ 往回）
      if (e.code === 'Space' && !typing && spaceCanPan(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        if (!e.repeat && !spaceDown.current) {
          spaceDown.current = true
          spaceDragged.current = false
          setSpaceHand(true)
          window.getSelection()?.removeAllRanges()
          setSelBar(null)
        }
        return
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return
      if (selBar && e.key.toLowerCase() === 'h') return e.preventDefault(), void create('highlight', lastColor)
      if (selBar && e.key.toLowerCase() === 'u') return e.preventDefault(), void create('underline', lastColor)
      if (e.key.toLowerCase() === 'v') return e.preventDefault(), chooseTool('select')
      if (e.key.toLowerCase() === 'h') return e.preventDefault(), chooseTool('hand')
      if (e.key.toLowerCase() === 'm') return e.preventDefault(), chooseTool('highlight')
      if (e.key.toLowerCase() === 'u') return e.preventDefault(), chooseTool('underline')
      if (selBar && e.key.toLowerCase() === 'n') return e.preventDefault(), void create('highlight', lastColor).then((made) => made[0] && toNote(made[0]))
    }
    const ku = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !spaceDown.current) return
      // 焦点在工具栏按钮上时，空格松开默认会"按"一下那个按钮
      e.preventDefault()
      spaceDown.current = false
      setSpaceHand(false)
      const c = scrollRef.current
      if (c && !spaceDragged.current) c.scrollBy({ top: (e.shiftKey ? -0.9 : 0.9) * c.clientHeight })
    }
    // 按着空格切走窗口时收不到 keyup：直接放开，不翻页
    const blur = () => {
      if (!spaceDown.current) return
      spaceDown.current = false
      setSpaceHand(false)
    }
    window.addEventListener('keydown', k)
    window.addEventListener('keyup', ku)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', k)
      window.removeEventListener('keyup', ku)
      window.removeEventListener('blur', blur)
    }
  })

  // —— 右边两栏：批注和笔记一栏，AI 一栏。各自开关，都开着时并排 ——
  // 菜单栏 显示 › 批注和笔记 / AI 转到这里
  useEffect(() => {
    const on = (e: Event) => {
      const c = (e as CustomEvent<string>).detail
      if (c === 'toggleNotes') toggleSide('panel')
      if (c === 'toggleAi') toggleSide('ai')
    }
    window.addEventListener('reader-cmd', on)
    return () => window.removeEventListener('reader-cmd', on)
  })
  type Tab = 'annos' | 'note'
  const [tab, setTab] = useState<Tab>(() => { const t = pref.get('tab'); return t === 'note' || t === 'both' ? 'note' : 'annos' })
  // 以前 AI 是右栏里的一个标签页，用过的人直接给他开着 AI 栏
  const [showAi, setShowAi] = useState(() => pref.get('ai') === '1' || (pref.get('ai') === null && (pref.get('tab') === 'ai' || pref.get('tab') === 'both')))
  /** 选中拿来问 AI 的文字 */
  const [aiQuote, setAiQuote] = useState<{ text: string; n: number } | null>(null)
  const [panelW, setPanelW] = useState(() => Math.min(640, Math.max(260, Number(pref.get('panelW')) || 320)))
  const [aiW, setAiW] = useState(() => Math.min(640, Math.max(280, Number(pref.get('aiW')) || 360)))
  // 窗口窄的时候论文要留够地方：先收缩略图；两栏都开着就只留刚才用的那一栏；还不够就把那一栏挤窄。
  // 只是这时候不显示，开关的设置不改，窗口拉宽了就都回来
  const [lastSide, setLastSide] = useState<'panel' | 'ai'>('panel')
  const winW = useWindowWidth()
  const room = (thumbs: boolean, panel: boolean, ai: boolean) => winW - (thumbs ? THUMBS_W : 0) - (panel ? panelW : 0) - (ai ? aiW : 0)
  let seeThumbs = showThumbs
  let seePanel = showPanel
  let seeAi = showAi
  if (room(seeThumbs, seePanel, seeAi) < MIN_STAGE_W) seeThumbs = false
  if (room(seeThumbs, seePanel, seeAi) < MIN_STAGE_W && seePanel && seeAi) {
    if (lastSide === 'ai') seePanel = false
    else seeAi = false
  }
  const sideCap = Math.max(240, winW - MIN_STAGE_W - (seeThumbs ? THUMBS_W : 0) - (seePanel && seeAi ? Math.min(panelW, aiW) : 0))
  const paperNotes = useMemo(() => notes.filter((n) => n.paperId === paper.id), [notes, paper.id])
  const [noteId, setNoteId] = useState<string | null>(null)
  /** 正在写一篇还没存盘的新笔记 */
  const [drafting, setDrafting] = useState(false)
  /** 编辑器的 key：只在用户换笔记时变，草稿建成文件时不重建 */
  const [slot, setSlot] = useState(0)
  const [focusNote, setFocusNote] = useState(false)
  const currentNote = drafting ? undefined : paperNotes.find((n) => n.id === noteId) ?? paperNotes[0]
  const editor = useRef<EditorHandle | null>(null)
  const switchTab = (t: Tab) => {
    setTab(t)
    pref.set('tab', t)
    setFocusNote(t === 'note')
    setLastSide('panel')
    if (!showPanel) togglePref('panel', true, setShowPanel)
  }
  const openAi = () => {
    setLastSide('ai')
    if (!showAi) togglePref('ai', true, setShowAi)
  }
  /** 工具栏上那两栏的按钮：开着但因为窗口窄没显示出来时，点一下是把它换出来，不是关掉 */
  const toggleSide = (k: 'panel' | 'ai') => {
    const [on, seen, set] = k === 'panel' ? [showPanel, seePanel, setShowPanel] as const : [showAi, seeAi, setShowAi] as const
    if (on && !seen) setLastSide(k)
    else togglePref(k, !on, set)
  }
  const newPaperNote = () => {
    setDrafting(true)
    setNoteId(null)
    setSlot((n) => n + 1)
    setFocusNote(true)
  }
  /** 摘到笔记：在这篇的笔记末尾加一个引用块，能跳回原文 */
  const toNote = async (a: Annotation) => {
    setActive(null)
    await appendToNote(quoteBlock(a.target.quote.exact, a.page + 1, a.id, a.comment))
  }
  /** 往这篇的笔记末尾加一段；没有笔记就新建一篇 */
  const appendToNote = async (block: string) => {
    if (editor.current) {
      // 笔记栏开着（草稿也算）：直接写进编辑器
      switchTab('note')
      editor.current.append(block)
    } else if (!currentNote) {
      const n = await api.notes.create({ paperId: paper.id, title: paper.title, body: block + '\n' })
      setNoteId(n.id)
      switchTab('note')
    } else {
      const r = await api.notes.read(currentNote.id)
      const body = r?.body ?? ''
      await api.notes.save(currentNote.id, body + (body.endsWith('\n\n') || !body ? '' : body.endsWith('\n') ? '\n' : '\n\n') + block + '\n')
      switchTab('note')
    }
    toast({ text: '已摘到笔记' })
  }
  /** 拖栏的左边缘改宽度；两栏各记各的 */
  const startResize = (e: React.PointerEvent, startW: number, set: (w: number) => void, key: 'panelW' | 'aiW', min: number) => {
    e.preventDefault()
    const startX = e.clientX
    let w = startW
    const move = (ev: PointerEvent) => {
      w = Math.min(640, Math.max(min, startW + (startX - ev.clientX)))
      set(w)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      pref.set(key, String(Math.round(w)))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }


  // 从笔记里点回来：文档和批注都准备好后跳过去
  const jumped = useRef(0)
  useEffect(() => {
    if (!jump || jumped.current === jump.n || !doc || !ready) return
    const a = annos.find((x) => x.id === jump.id)
    if (!a) return
    jumped.current = jump.n
    // 缩放按窗口宽度重算会关掉浮层，等它稳定下来再跳
    setTimeout(() => jumpTo(a), 250)
  })

  const togglePref = (k: 'thumbs' | 'panel' | 'ai', v: boolean, set: (v: boolean) => void) => {
    set(v)
    pref.set(k, v ? '1' : '0')
    if (v && k !== 'thumbs') setLastSide(k)
  }

  const activeAnno = active ? annos.find((a) => a.id === active.id) : undefined
  const pagesWithNotes = useMemo(() => new Set(annos.map((a) => a.page + 1)), [annos])
  const pageCount = doc?.numPages ?? file.pageCount ?? 0
  const scaleLabel = scale.preset === 'auto' ? '自动' : scale.preset === 'page-width' ? '适合宽度' : scale.preset === 'page-fit' ? '整页' : `${Math.round(scale.value * 100)}%`

  const noteView = (
    <div className="panel-note" role="tabpanel">
      {(paperNotes.length > 1 || (drafting && paperNotes.length > 0)) && (
        <label className="select panel-note-pick">
          <span className="sr">选择笔记</span>
          <select value={currentNote?.id ?? ''} onChange={(e) => { setDrafting(false); setNoteId(e.target.value); setSlot((n) => n + 1) }}>
            {!currentNote && <option value="">新笔记</option>}
            {paperNotes.map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}
          </select>
          <Icon name="down" size={14} />
        </label>
      )}
      <NoteEditor
        key={`${paper.id}:${slot}`}
        noteId={currentNote?.id ?? null}
        draft={{ paperId: paper.id, title: paper.title }}
        onCreated={(id) => { setDrafting(false); setNoteId(id) }}
        notes={notes}
        compact
        autoFocus={focusNote}
        handle={editor}
        onOpenNote={onOpenNoteTitle}
        onOpenAnnotation={onOpenAnnotation}
        onDeleted={() => { setNoteId(null); setDrafting(false); setSlot((n) => n + 1) }}
        onNew={newPaperNote}
      />
    </div>
  )
  const aiView = <AiPanel paperId={paper.id} status={aiStatus} quote={aiQuote} onCite={citeJump} onOpenSettings={onOpenSettings} onToNote={(md) => void appendToNote(md)} onHide={() => togglePref('ai', false, setShowAi)} />

  return (
    <div className={`reader paper-${dark ? 'dark' : 'light'}${focus ? ' focus' : ''}`}>
      <header className="reader-bar drag">
        <button type="button" className="icon-btn reader-back no-drag" aria-label={`返回${backLabel}`} title={kbd(`返回${backLabel}（⌘[）`)} onClick={onBack}><Icon name="back" /></button>
        {!focus && <button type="button" className="icon-btn tool no-drag" aria-pressed={seeThumbs} aria-label="显示缩略图" title={showThumbs ? kbd('隐藏缩略图（⌥⌘S）') : kbd('显示缩略图（⌥⌘S）')} onClick={() => togglePref('thumbs', !showThumbs, setShowThumbs)}><Icon name="thumbs" /></button>}
        <div className="reader-title">
          <span className="reader-name" title={paper.title}>{paper.title}</span>
          {pageCount > 0 && (
            <label className="reader-page no-drag">
              <span>第</span>
              <input
                className="num"
                aria-label="页码"
                value={pageInput}
                inputMode="numeric"
                onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => { if (e.key === 'Enter') { goPage(Number(pageInput)); (e.target as HTMLInputElement).blur() } }}
                onBlur={() => setPageInput(String(page))}
                style={{ width: `${Math.max(2, String(pageCount).length) + 1.2}ch` }}
              />
              <span>页，共 {pageCount} 页</span>
            </label>
          )}
        </div>
        {doc && paper.readingStatus !== 'done' && nearEnd(page, doc.numPages) && (
          <button type="button" className="btn btn-s mark-done no-drag" onClick={() => onStatus('done')}><Icon name="done" size={14} />标为读过</button>
        )}
        <div className="reader-tools no-drag">
          <div className="zoom" role="group" aria-label="缩放">
            <button type="button" className="icon-btn tool" aria-label="缩小" title={kbd('缩小（⌘-，或按住 Ctrl 滚动滚轮）')} onClick={() => zoom(-1)}><Icon name="minus" size={16} /></button>
            <button type="button" className="zoom-l num" title={kbd('自动大小（⌘0）')} onClick={() => zoom(0)}>{scaleLabel}</button>
            <button type="button" className="icon-btn tool" aria-label="放大" title={kbd('放大（⌘+，或按住 Ctrl 滚动滚轮）')} onClick={() => zoom(1)}><Icon name="plus" size={16} /></button>
          </div>
          <button type="button" className="icon-btn tool" aria-pressed={find.open} aria-label="在文中查找" title={kbd('在文中查找（⌘F）')} onClick={() => (find.open ? closeFind() : openFind())}><Icon name="search" /></button>
          <div className="reader-more">
            <button type="button" className="icon-btn tool" aria-haspopup="menu" aria-expanded={more} aria-label="更多" title="更多：论文详情、深色 / 浅色" onClick={() => setMore((v) => !v)}><Icon name="more" /></button>
            {more && (
              <div className="menu" role="menu" onMouseLeave={() => setMore(false)}>
                <button type="button" role="menuitem" onClick={() => { setMore(false); onInfo() }}>论文详情</button>
                <button type="button" role="menuitem" onClick={() => { setMore(false); void api.setAppearance(dark ? 'light' : 'dark') }}>{dark ? '换成浅色外观' : '换成深色外观'}</button>
              </div>
            )}
          </div>
          <button type="button" className="icon-btn tool" aria-pressed={focus} aria-label={focus ? '退出全屏阅读' : '全屏阅读'} title={focus ? '退出全屏阅读（Esc）' : kbd(kbd(`全屏阅读：只留论文（${FOCUS_KEY}）`))} onClick={toggleFocus}><Icon name={focus ? 'shrink' : 'fit'} /></button>
          {!focus && <button type="button" className="icon-btn tool" aria-pressed={seePanel} aria-label="批注和笔记" title={seePanel ? kbd('隐藏批注和笔记（⌥⌘N）') : kbd('显示批注和笔记（⌥⌘N）')} onClick={() => toggleSide('panel')}><Icon name="panel" /></button>}
          {!focus && <button type="button" className="icon-btn tool" aria-pressed={seeAi} aria-label="AI" title={seeAi ? kbd('隐藏 AI（⌥⌘A）') : kbd('显示 AI（⌥⌘A）：可以和笔记并排')} onClick={() => toggleSide('ai')}><Icon name="sparkle" /></button>}
        </div>
      </header>

      <div className="reader-body">
        {seeThumbs && !focus && (doc ? <Thumbnails doc={doc} current={page} marked={pagesWithNotes} onGo={goPage} /> : <nav className="thumbs tray" aria-label="页面缩略图" />)}

        <div className="reader-stage">
          {find.open && (
            <div className="findbar" role="search">
              <label className="filter">
                <Icon name="search" size={16} />
                <span className="sr">在文中查找</span>
                <input
                  ref={findInput}
                  type="text"
                  placeholder="在文中查找"
                  value={find.query}
                  onChange={(e) => { setFind((f) => ({ ...f, query: e.target.value })); runFind(e.target.value) }}
                  onKeyDown={(e: ReactKeyboardEvent) => {
                    if (composing(e)) return
                    if (e.key === 'Enter') runFind(find.query, true, e.shiftKey)
                    if (e.key === 'Escape') { e.stopPropagation(); closeFind() }
                  }}
                />
              </label>
              <span className="find-count num" aria-live="polite">
                {!find.query ? '' : find.state === FindState.PENDING ? '查找中…' : find.total ? `${find.current} / ${find.total}` : find.state === FindState.NOT_FOUND ? '没有找到' : ''}
              </span>
              <button type="button" className="icon-btn tool" aria-label="上一个" title={kbd('上一个（⇧↩）')} disabled={!find.total} onClick={() => runFind(find.query, true, true)}><Icon name="up" size={16} /></button>
              <button type="button" className="icon-btn tool" aria-label="下一个" title={kbd('下一个（↩）')} disabled={!find.total} onClick={() => runFind(find.query, true)}><Icon name="down" size={16} /></button>
              <button type="button" className="icon-btn tool" aria-label="关闭查找" onClick={closeFind}><Icon name="close" size={16} /></button>
            </div>
          )}
          {error && (
            <div className="reader-error card">
              <b>{error}</b>
              {error === MISSING ? (
                <>
                  <p className="hint">批注和笔记都还在。选回同一个文件，批注会照原样显示。</p>
                  <button type="button" className="btn btn-p" onClick={() => void relink()}>重新选择 PDF…</button>
                </>
              ) : (
                <button type="button" className="btn" onClick={() => void api.library.openFile(paper.id)}><Icon name="open" size={16} />用其他程序打开</button>
              )}
            </div>
          )}
          {!doc && !error && <div className="reader-loading" aria-live="polite"><Spinner />正在打开</div>}
          {doc && <ReaderToolbar tool={hand ? 'hand' : tool} color={activeAnno?.color ?? lastColor} colorFor={activeAnno ? '这条批注' : null} onTool={chooseTool} onColor={(c) => { pickColor(c); if (activeAnno) recolor(activeAnno, c) }} />}
          <div ref={scrollRef} className={`reader-scroll${hand ? ' hand' : ''}${panning ? ' panning' : ''}${tool === 'highlight' || tool === 'underline' ? ' marking' : ''}`} tabIndex={0} aria-label="论文页面" onPointerDown={onPointerDown} onPointerUp={onPointerUp} onDoubleClick={onDoubleClick} onContextMenu={onContextMenu} onMouseOver={onLinkOver} onMouseOut={onLinkOut} onScroll={() => { if (ctx) setCtx(null); if (peek) setPeek(null) }}>
            <div ref={viewerRef} className="pdfViewer" />


            {ctx && (
              <div className="reader-float menu ctx-menu" style={{ left: ctx.at.x, top: ctx.at.y } as CSSProperties} role="menu" onMouseDown={(e) => e.preventDefault()}>
                {ctx.bar && (
                  <>
                    <button type="button" role="menuitem" onClick={() => { setCtx(null); void create('note', lastColor, true, ctx.bar) }}>添加批注</button>
                    <button type="button" role="menuitem" onClick={() => { setCtx(null); void create('highlight', lastColor, false, ctx.bar).then((made) => made[0] && toNote(made[0])) }}>摘到笔记</button>
                  </>
                )}
                {ctx.anno && (
                  <>
                    <button type="button" role="menuitem" onClick={() => { const a = ctx.anno!; setCtx(null); setActive({ id: a.id, at: spotFor(a) ?? ctx.at, focus: true }) }}>{ctx.anno.comment ? '编辑批注' : '添加批注'}</button>
                    <button type="button" role="menuitem" onClick={() => { const a = ctx.anno!; setCtx(null); void toNote(a) }}>摘到笔记</button>
                  </>
                )}
                {ctx.text && <button type="button" role="menuitem" onClick={() => askAi(ctx.text)}>问 AI</button>}
                {ctx.text && <button type="button" role="menuitem" onClick={() => translate(ctx.text, ctx.at)}>翻译</button>}
                {ctx.text && <button type="button" role="menuitem" onClick={() => { void navigator.clipboard.writeText(ctx.text); setCtx(null); toast({ text: '已复制' }) }}>复制</button>}
                {ctx.anno && <button type="button" role="menuitem" className="danger" onClick={() => { const a = ctx.anno!; setCtx(null); void remove(a) }}>删除</button>}
              </div>
            )}

            {trans && <TranslateCard key={`${trans.text}@${trans.at.x},${trans.at.y}`} text={trans.text} at={trans.at} paperId={paper.id} terms={terms} onClose={closeTrans} onOpenSettings={onOpenSettings} toast={toast} />}

            {peek && (
              <div className={'reader-float link-peek' + (peek.above ? ' above' : '')} style={{ left: peek.at.x, top: peek.at.y + (peek.above ? -6 : 6) } as CSSProperties} aria-hidden="true">
                <img src={peek.src} width={peek.w} height={peek.h} alt="" />
                <span className="link-peek-foot">第 {peek.page} 页 · 点击跳过去</span>
              </div>
            )}

            {activeAnno && active && active.from !== 'list' && (
              <AnnotationCard
                key={activeAnno.id}
                a={activeAnno}
                at={inView(active.at, 150)}
                focus={active.focus ?? false}
                onComment={(text) => void update(activeAnno.id, { comment: text })}
                onColor={(c) => recolor(activeAnno, c)}
                onRemove={() => void remove(activeAnno)}
                onToNote={() => void toNote(activeAnno)}
                onClose={() => setActive(null)}
              />
            )}
          </div>
        </div>

        {seePanel && !focus && (
          <aside className="reader-panel" style={{ flexBasis: Math.min(panelW, sideCap) } as CSSProperties} aria-label="批注和笔记">
            <div className="panel-resize" role="separator" aria-orientation="vertical" aria-label="拖动调整宽度" onPointerDown={(e) => startResize(e, panelW, setPanelW, 'panelW', 260)} />
            <div className="panel-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'annos'} onClick={() => switchTab('annos')}>批注 · {annos.length}</button>
              <button type="button" role="tab" aria-selected={tab === 'note'} onClick={() => switchTab('note')}>笔记{paperNotes.length ? ` · ${paperNotes.length}` : ''}</button>
            </div>
            {tab === 'annos' ? (
              <AnnoList
                annos={annos}
                activeId={active?.id ?? null}
                expandedId={active?.from === 'list' ? active.id : null}
                onSelect={(a) => {
                  jumpTo(a, false)
                  requestAnimationFrame(() => setActive({ id: a.id, at: spotFor(a) ?? { x: 0, y: 0 }, from: 'list' }))
                }}
                onCollapse={() => setActive(null)}
                onComment={(a, text) => void update(a.id, { comment: text })}
                onColor={recolor}
                onRemove={(a) => void remove(a)}
                onToNote={(a) => void toNote(a)}
                onCopy={(a) => { void navigator.clipboard.writeText(a.target.quote.exact); toast({ text: '已复制' }) }}
              />
            ) : (
              noteView
            )}
          </aside>
        )}

        {seeAi && !focus && (
          <aside className="reader-panel" style={{ flexBasis: Math.min(aiW, sideCap) } as CSSProperties} aria-label="AI">
            <div className="panel-resize" role="separator" aria-orientation="vertical" aria-label="拖动调整宽度" onPointerDown={(e) => startResize(e, aiW, setAiW, 'aiW', 280)} />
            {aiView}
          </aside>
        )}
      </div>
    </div>
  )
}

/** 选中这个位置上的一个词（论文的文字层里）；没有词返回 false */
function selectWordAt(x: number, y: number, root: HTMLElement | null): boolean {
  // 抓手下文字层不接收鼠标，找位置时临时打开
  root?.classList.add('hit-text')
  const pos = document.caretPositionFromPoint(x, y)
  root?.classList.remove('hit-text')
  const node = pos?.offsetNode
  if (!root || !pos || !node || node.nodeType !== Node.TEXT_NODE || !node.parentElement?.closest('.textLayer') || !root.contains(node)) return false
  const text = node.textContent ?? ''
  const seg = new Intl.Segmenter(undefined, { granularity: 'word' })
  // 落在一个词的后半时 offset 可能正好在词尾，往前看一个字
  for (const at of [pos.offset, pos.offset - 1]) {
    const hit = [...seg.segment(text)].find((s) => s.isWordLike && at >= s.index && at < s.index + s.segment.length)
    if (!hit) continue
    const range = document.createRange()
    range.setStart(node, hit.index)
    range.setEnd(node, hit.index + hit.segment.length)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    return true
  }
  return false
}

/**
 * 按空格能不能切到小手。点过工具栏、顶栏或页面里的按钮后焦点留在按钮上，这时空格也该拖页面，
 * 而不是去"按"那个按钮；侧栏、弹出的卡片和菜单里的按钮、下拉框、可编辑的地方照常。
 */
function spaceCanPan(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el?.closest) return true
  if (el.closest('select, [contenteditable], .reader-float, [role="menu"], [role="listbox"], [role="dialog"]')) return false
  if (!el.closest('button, a')) return true
  return !!el.closest('.reader-toolbar, .reader-bar, .reader-scroll')
}

function AnnotationCard({ a, at, focus, onComment, onColor, onRemove, onClose, onToNote }: {
  a: Annotation
  at: Spot
  focus: boolean
  onComment: (text: string) => void
  onColor: (c: HighlightColor) => void
  onRemove: () => void
  onClose: () => void
  onToNote: () => void
}) {
  const [text, setText] = useState(a.comment ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (focus) ref.current?.focus()
  }, [focus])
  const save = () => {
    if (text !== (a.comment ?? '')) onComment(text)
  }
  return (
    <div className="reader-float anno-card" style={{ left: at.x, top: at.y + 8 } as CSSProperties} role="dialog" aria-label="批注">
      <label className="anno-card-note">
        <span className="sr">批注内容</span>
        <textarea
          ref={ref}
          rows={2}
          placeholder={kbd('写点什么…（⌘↩ 保存）')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && mod(e)) { save(); onClose() }
            if (e.key === 'Escape') { e.stopPropagation(); save(); onClose() }
          }}
        />
      </label>
      <div className="anno-card-row">
        {COLORS.map((c) => (
          <button key={c.id} type="button" className={`swatch swatch-s sw-${c.id}`} aria-label={a.type === 'note' ? `涂成${c.label}` : c.label} title={a.type === 'note' ? `涂成${c.label}高亮` : c.label} aria-pressed={a.type !== 'note' && a.color === c.id} onClick={() => onColor(c.id)} />
        ))}
        <span className="grow" />
        <button type="button" className="link" onClick={onToNote}>摘到笔记</button>
        <button type="button" className="icon-btn tool" aria-label="删除批注" title="删除批注" onClick={onRemove}><Icon name="trash" size={16} /></button>
      </div>
    </div>
  )
}
