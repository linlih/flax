// 网页版里双击一张图：按窗口大小放大看（最多放大到 4 倍）。点哪里、按 Esc 或点 × 关掉。
import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icon'

/** 四周留的空，和 .figure-view 的 padding 一致：上面留出工具栏和关闭按钮 */
const PAD_X = 64
const PAD_Y = 124
const MAX_SCALE = 4

export function FigureViewer({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const ref = useRef<HTMLImageElement>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const fit = useCallback(() => {
    const img = ref.current
    if (!img || !img.naturalWidth || !img.naturalHeight) return
    const s = Math.min((window.innerWidth - PAD_X) / img.naturalWidth, (window.innerHeight - PAD_Y) / img.naturalHeight, MAX_SCALE)
    setSize({ w: Math.round(img.naturalWidth * s), h: Math.round(img.naturalHeight * s) })
  }, [])

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose())
    window.addEventListener('keydown', k, true)
    window.addEventListener('resize', fit)
    return () => {
      window.removeEventListener('keydown', k, true)
      window.removeEventListener('resize', fit)
    }
  }, [onClose, fit])

  return (
    <div className="figure-view" role="dialog" aria-modal="true" aria-label="放大的图" onClick={onClose}>
      <img ref={ref} src={src} alt={alt} onLoad={fit} style={size ? { width: size.w, height: size.h } : { visibility: 'hidden' }} />
      <button type="button" className="icon-btn figure-view-close" aria-label="关闭" autoFocus onClick={onClose}>
        <Icon name="close" size={16} />
      </button>
    </div>
  )
}
