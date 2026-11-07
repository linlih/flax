// 左边的缩略图栏：滚到才画，当前页描边，有批注的页带一个小点。
import { useEffect, useRef } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'

const WIDTH = 104

export function Thumbnails({ doc, current, marked, onGo }: { doc: PDFDocumentProxy; current: number; marked: Set<number>; onGo: (n: number) => void }) {
  const listRef = useRef<HTMLDivElement>(null)

  // 当前页跟着滚进可见范围
  useEffect(() => {
    listRef.current?.querySelector(`[data-page="${current}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const pages = Array.from({ length: doc.numPages }, (_, i) => i + 1)
  return (
    <nav className="thumbs tray" aria-label="页面缩略图">
      <div ref={listRef} className="thumbs-list">
        {pages.map((n) => (
          <button key={n} type="button" data-page={n} className="thumb-item" aria-current={n === current ? 'page' : undefined} aria-label={`第 ${n} 页`} onClick={() => onGo(n)}>
            <Thumb doc={doc} n={n} root={listRef} />
            <span className="thumb-n num">{n}{marked.has(n) && <span className="thumb-dot" aria-label="有批注" />}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}

function Thumb({ doc, n, root }: { doc: PDFDocumentProxy; n: number; root: React.RefObject<HTMLDivElement | null> }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current!
    let task: { cancel(): void; promise: Promise<void> } | null = null
    let done = false
    const draw = async () => {
      if (done) return
      done = true
      const page = await doc.getPage(n)
      const base = page.getViewport({ scale: 1 })
      const dpr = window.devicePixelRatio || 1
      const vp = page.getViewport({ scale: (WIDTH / base.width) * dpr })
      canvas.width = Math.floor(vp.width)
      canvas.height = Math.floor(vp.height)
      canvas.style.aspectRatio = `${base.width} / ${base.height}`
      task = page.render({ canvas, viewport: vp })
      await task.promise.catch(() => {})
    }
    // 页面尺寸先按第一页的比例占位
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && void draw(), { root: root.current, rootMargin: '400px 0px' })
    io.observe(canvas)
    return () => {
      io.disconnect()
      task?.cancel()
    }
  }, [doc, n, root])
  return <span className="thumb-frame"><canvas ref={ref} className="thumb-canvas" style={{ width: WIDTH }} /></span>
}
