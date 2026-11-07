// 页面底部居中的工具栏，照 Figma 编辑页面的做法：工具平铺，当前工具实心高亮，悬停显示名字和快捷键。
// 按住空格临时变抓手、松开回来，Esc 回到选择（这些逻辑在 Reader 里）。
import { useEffect, useRef, useState } from 'react'
import type { HighlightColor } from '@paper/core'
import { Icon } from '../components/Icon'
import { COLORS } from './colors'

export type Tool = 'select' | 'hand' | 'highlight' | 'underline'

const TOOLS: { id: Tool; label: string; key: string; icon: 'textcursor' | 'hand' | 'highlight' | 'underline' }[] = [
  { id: 'select', label: '选择文字', key: 'V', icon: 'textcursor' },
  { id: 'hand', label: '移动页面', key: 'H', icon: 'hand' },
  { id: 'highlight', label: '高亮', key: 'M', icon: 'highlight' },
  { id: 'underline', label: '下划线', key: 'U', icon: 'underline' }
]

/** colorFor：选中了一条批注时，颜色按钮改的是它（比如"这条批注"）；没选中时改的是之后新标注的颜色 */
export function ReaderToolbar({ tool, color, colorFor, onTool, onColor }: { tool: Tool; color: HighlightColor; colorFor: string | null; onTool: (t: Tool) => void; onColor: (c: HighlightColor) => void }) {
  const [colors, setColors] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!colors) return
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setColors(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), setColors(false))
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', esc, true)
    return () => {
      window.removeEventListener('pointerdown', away)
      window.removeEventListener('keydown', esc, true)
    }
  }, [colors])

  const name = COLORS.find((c) => c.id === color)?.label ?? ''
  const label = colorFor ? `${colorFor}的颜色：${name}` : `标注颜色：${name}`

  return (
    <div className="reader-toolbar" ref={root} role="toolbar" aria-label="工具">
      {TOOLS.map((t, i) => (
        <span key={t.id} className="tb-slot">
          {i === 2 && <span className="tb-sep" />}
          <button type="button" className="tb-btn" aria-pressed={tool === t.id} aria-label={t.label} title={`${t.label}  ${t.key}`} onClick={() => onTool(t.id)}>
            <Icon name={t.icon} size={18} />
          </button>
        </span>
      ))}
      <button type="button" className="tb-btn tb-color-btn" aria-label={label} title={label} aria-haspopup="true" aria-expanded={colors} onClick={() => setColors(!colors)}>
        <span className={`tb-dot sw-${color}`} />
      </button>
      {colors && (
        <div className="tb-colors" role="group" aria-label="标注颜色">
          {COLORS.map((c) => (
            <button key={c.id} type="button" className={`swatch sw-${c.id}`} aria-label={c.label} title={c.label} aria-pressed={color === c.id} onClick={() => { onColor(c.id); setColors(false) }} />
          ))}
        </div>
      )}
    </div>
  )
}
