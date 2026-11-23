// 网页版里双击一张图：盖住整个窗口看大图（像"快速查看"），下面是图注。
// 先按窗口大小铺开；双击图在"铺满"和"放大"之间切换，捏合 / ⌘滚轮 / ⌘+ ⌘− 随意缩放，放大后拖动或滚动来移动。
// 点空白处、按 Esc 或点 × 关掉；点在图上不关（免得和双击冲突）。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icon'

/** 铺满时最多把小图放大这么多倍 */
const MAX_FIT = 4
/** 在铺满的基础上最多再放大这么多倍 */
export const MAX_ZOOM = 8
/** 双击放大到铺满的几倍 */
const DOUBLE_ZOOM = 2.5

export interface Box {
  w: number
  h: number
}
/** s：相对铺满的倍数；x、y：图中心离舞台中心的偏移（像素） */
export interface View {
  s: number
  x: number
  y: number
}
export const FIT: View = { s: 1, x: 0, y: 0 }

/** 铺满舞台的大小：保持比例，小图最多放大 MAX_FIT 倍 */
export function fitSize(natural: Box, stage: Box): Box {
  const k = Math.min(stage.w / natural.w, stage.h / natural.h, MAX_FIT)
  return { w: Math.round(natural.w * k), h: Math.round(natural.h * k) }
}

/** 图比舞台大的方向才能移动，而且不能把图移出舞台 */
export function clampView(v: View, fit: Box, stage: Box): View {
  const mx = Math.max(0, (fit.w * v.s - stage.w) / 2)
  const my = Math.max(0, (fit.h * v.s - stage.h) / 2)
  // + 0：把 -0 变成 0
  return { s: v.s, x: Math.min(mx, Math.max(-mx, v.x)) + 0, y: Math.min(my, Math.max(-my, v.y)) + 0 }
}

/** 以舞台里的一点（相对舞台中心）为中心缩放：鼠标下的那一点不动 */
export function zoomAt(v: View, factor: number, px: number, py: number, fit: Box, stage: Box): View {
  const s = Math.min(MAX_ZOOM, Math.max(1, v.s * factor))
  const k = s / v.s
  return clampView({ s, x: px - (px - v.x) * k, y: py - (py - v.y) * k }, fit, stage)
}

export function FigureViewer({ src, alt, caption, onClose }: { src: string; alt: string; caption: string; onClose: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null)
  const [natural, setNatural] = useState<Box | null>(null)
  const [stage, setStage] = useState<Box | null>(null)
  const [view, setView] = useState<View>(FIT)
  const [dragging, setDragging] = useState(false)
  const fit = natural && stage ? fitSize(natural, stage) : null

  // 舞台随窗口变大小：重新铺满
  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = () => {
      setStage({ w: el.clientWidth, h: el.clientHeight })
      setView(FIT)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /** 舞台里的一点（相对舞台中心）；没给坐标就是中心 */
  const at = useCallback((clientX?: number, clientY?: number): [number, number] => {
    const r = stageRef.current?.getBoundingClientRect()
    if (!r || clientX === undefined || clientY === undefined) return [0, 0]
    return [clientX - r.left - r.width / 2, clientY - r.top - r.height / 2]
  }, [])
  const zoom = useCallback((factor: number, clientX?: number, clientY?: number) => {
    if (!fit || !stage) return
    const [px, py] = at(clientX, clientY)
    setView((v) => zoomAt(v, factor, px, py, fit, stage))
  }, [fit, stage, at])

  // 键盘：Esc 关；⌘+ ⌘− ⌘0 缩放这张图（不去缩放后面的页面）
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey
      if (e.key === 'Escape') onClose()
      else if (cmd && (e.key === '=' || e.key === '+')) zoom(1.25)
      else if (cmd && e.key === '-') zoom(0.8)
      else if (cmd && e.key === '0') setView(FIT)
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [onClose, zoom])

  // 滚轮：捏合（Chromium 里是带 ctrl 的滚轮）或 ⌘滚轮缩放；放大后普通滚动用来移动
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (!fit || !stage) return
      if (e.ctrlKey || e.metaKey) return zoom(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY)
      setView((v) => (v.s > 1 ? clampView({ s: v.s, x: v.x - e.deltaX, y: v.y - e.deltaY }, fit, stage) : v))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [fit, stage, zoom])

  // 放大后拖动
  const onPointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    if (view.s <= 1 || e.button !== 0 || !fit || !stage) return
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const start = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
    setDragging(true)
    const move = (m: PointerEvent) => setView((v) => clampView({ s: v.s, x: start.vx + m.clientX - start.x, y: start.vy + m.clientY - start.y }, fit, stage))
    const up = () => {
      setDragging(false)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const zoomed = view.s > 1.001
  return (
    <div className={'figure-view' + (zoomed ? ' zoomed' : '') + (dragging ? ' dragging' : '')} role="dialog" aria-modal="true" aria-label={caption || '放大的图'}>
      <div ref={stageRef} className="figure-view-stage" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <img
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth || 1, h: e.currentTarget.naturalHeight || 1 })}
          onPointerDown={onPointerDown}
          onDoubleClick={(e) => (zoomed ? setView(FIT) : zoom(DOUBLE_ZOOM, e.clientX, e.clientY))}
          style={fit ? { width: fit.w * view.s, height: fit.h * view.s, transform: `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px))` } : { visibility: 'hidden' }}
        />
      </div>
      {caption && <p className="figure-view-cap">{caption}</p>}
      <button type="button" className="icon-btn figure-view-close" aria-label="关闭" title="关闭（Esc）" autoFocus onClick={onClose}>
        <Icon name="close" size={16} />
      </button>
    </div>
  )
}
