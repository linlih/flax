// 侧栏的批注列表：按页分组，一条一行（不再每条一张卡片）。评论用自己的样式，一眼看出哪条写了东西。
// 在列表里点一条：跳过去，并在这一行里展开，直接改评论、换颜色、摘到笔记、复制、删除（跟 Zotero 一样），
// 不再弹页面上的浮动卡片。在页面上点高亮时，列表滚到那一条并标出来。批注多了才显示按颜色、有没有评论筛选。
// 右键一条：添加/编辑评论、摘到笔记、复制原文、删除，和页面上右键高亮一样。
import { useEffect, useMemo, useRef, useState } from 'react'
import { quoteBlock, type Annotation, type HighlightColor } from '@paper/core'
import { Icon } from '../components/Icon'
import { COLORS } from './colors'
import { kbd, mod } from '../lib/platform'

/** 超过这么多条才显示筛选 */
const FILTER_MIN = 8

export function AnnoList({ annos, activeId, expandedId, onSelect, onCollapse, onComment, onColor, onRemove, onToNote, onCopy }: {
  annos: Annotation[]
  /** 选中的那条（列表里点的，或页面上点的） */
  activeId: string | null
  /** 在列表里点的那条：展开编辑 */
  expandedId: string | null
  onSelect: (a: Annotation) => void
  onCollapse: () => void
  onComment: (a: Annotation, text: string) => void
  onColor: (a: Annotation, color: HighlightColor) => void
  onRemove: (a: Annotation) => void
  onToNote: (a: Annotation) => void
  onCopy: (a: Annotation) => void
}) {
  const [colors, setColors] = useState<HighlightColor[]>([])
  const [withComment, setWithComment] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  /** 右键菜单 */
  const [menu, setMenu] = useState<{ a: Annotation; x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const away = (e: PointerEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(null)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), setMenu(null))
    const close = () => setMenu(null)
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', esc, true)
    window.addEventListener('blur', close)
    root.current?.addEventListener('scroll', close)
    const list = root.current
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', esc, true)
      window.removeEventListener('blur', close)
      list?.removeEventListener('scroll', close)
    }
  }, [menu])
  const pick = (fn: (a: Annotation) => void) => () => {
    if (!menu) return
    setMenu(null)
    fn(menu.a)
  }

  // 只写评论的（note）没有颜色，不算进颜色筛选
  const used = useMemo(() => COLORS.filter((c) => annos.some((a) => a.type !== 'note' && a.color === c.id)), [annos])
  const commented = annos.filter((a) => a.comment?.trim()).length
  const filtering = colors.length > 0 || withComment
  const shown = annos.filter((a) => (!colors.length || (a.type !== 'note' && colors.includes(a.color))) && (!withComment || !!a.comment?.trim()))
  const toggleColor = (c: HighlightColor) => setColors((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]))

  // 选中的那条滚进视野（页面上点高亮时也一样）
  useEffect(() => {
    if (!activeId) return
    root.current?.querySelector(`[data-anno="${activeId}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  return (
    <div ref={root} className="anno-list" role="tabpanel">
      {annos.length > FILTER_MIN && (
        <div className="anno-filter" role="toolbar" aria-label="筛选批注">
          {used.length > 1 && used.map((c) => (
            <button key={c.id} type="button" className={`anno-filter-sw sw-${c.id}`} aria-pressed={colors.includes(c.id)} aria-label={`只看${c.label}`} title={`只看${c.label}`} onClick={() => toggleColor(c.id)} />
          ))}
          {commented > 0 && (
            <button type="button" className="chip toggle" aria-pressed={withComment} onClick={() => setWithComment((v) => !v)}>
              <Icon name="comment" size={13} />有评论 · {commented}
            </button>
          )}
          {filtering && <button type="button" className="link anno-filter-clear" onClick={() => { setColors([]); setWithComment(false) }}>全部</button>}
        </div>
      )}
      {annos.length === 0 && <p className="hint anno-empty">用底部工具栏的高亮或下划线，选中文字就标上。</p>}
      {annos.length > 0 && shown.length === 0 && <p className="hint anno-empty">没有符合的批注。</p>}
      {shown.map((a, i) => (
        <div key={a.id} className="anno-entry">
          {(i === 0 || shown[i - 1]!.page !== a.page) && <div className="anno-page">第 {a.page + 1} 页</div>}
          <AnnoRow
            a={a}
            on={activeId === a.id}
            menuOn={menu?.a.id === a.id}
            open={expandedId === a.id}
            onSelect={() => onSelect(a)}
            onCollapse={onCollapse}
            onComment={(t) => onComment(a, t)}
            onColor={(c) => onColor(a, c)}
            onRemove={() => onRemove(a)}
            onToNote={() => onToNote(a)}
            onCopy={() => onCopy(a)}
            onMenu={(x, y) => setMenu({ a, x, y })}
          />
        </div>
      ))}
      {menu && (
        <div ref={menuRef} className="menu row-menu anno-menu" role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 168), top: Math.min(menu.y, window.innerHeight - 170) }} onMouseDown={(e) => e.preventDefault()}>
          <button type="button" role="menuitem" onClick={pick(onSelect)}>{menu.a.comment?.trim() ? '编辑评论' : '添加评论'}</button>
          <button type="button" role="menuitem" onClick={pick(onToNote)}>摘到笔记</button>
          <button type="button" role="menuitem" onClick={pick(onCopy)}>复制原文</button>
          <div className="menu-sep" />
          <button type="button" role="menuitem" className="danger" onClick={pick(onRemove)}>删除</button>
        </div>
      )}
    </div>
  )
}

function AnnoRow({ a, on, menuOn, open, onSelect, onCollapse, onComment, onColor, onRemove, onToNote, onCopy, onMenu }: {
  a: Annotation
  on: boolean
  /** 右键菜单开着的那条 */
  menuOn: boolean
  open: boolean
  onSelect: () => void
  onCollapse: () => void
  onComment: (text: string) => void
  onColor: (c: HighlightColor) => void
  onRemove: () => void
  onToNote: () => void
  onCopy: () => void
  onMenu: (x: number, y: number) => void
}) {
  const [text, setText] = useState(a.comment ?? '')
  useEffect(() => setText(a.comment ?? ''), [a.comment])
  const save = () => {
    if (text.trim() !== (a.comment ?? '').trim()) onComment(text.trim())
  }
  const comment = a.comment?.trim()

  return (
    <div
      data-anno={a.id}
      className={'anno-item' + (on ? ' on' : '') + (open ? ' open' : '') + (menuOn ? ' menu-on' : '')}
      draggable={!open}
      onContextMenu={(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY) }}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', quoteBlock(a.target.quote.exact, a.page + 1, a.id, a.comment) + '\n')
        e.dataTransfer.effectAllowed = 'copy'
      }}
    >
      <span className={a.type === 'note' ? 'anno-bar note' : `anno-bar sw-${a.color}`} aria-hidden="true" />
      <div className="anno-body">
        <button type="button" className="anno-main" onClick={onSelect} aria-expanded={open}>
          <span className={'anno-quote' + (a.type === 'underline' ? ' ul' : '')}>{a.target.quote.exact}</span>
          {comment && !open && <span className="anno-comment"><Icon name="comment" size={13} />{comment}</span>}
        </button>
        {open && (
          <div className="anno-edit">
            <label className="anno-card-note">
              <span className="sr">评论</span>
              <textarea
                rows={1}
                placeholder={kbd('写点什么…（⌘↩ 保存）')}
                value={text}
                autoFocus
                onChange={(e) => setText(e.target.value)}
                onBlur={save}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && mod(e)) { e.preventDefault(); save(); onCollapse() }
                  if (e.key === 'Escape') { e.stopPropagation(); save(); onCollapse() }
                }}
              />
            </label>
            <div className="anno-edit-row">
              {COLORS.map((c) => (
                <button key={c.id} type="button" className={`swatch swatch-s sw-${c.id}`} aria-label={c.label} title={c.label} aria-pressed={a.type !== 'note' && a.color === c.id} onClick={() => onColor(c.id)} />
              ))}
              <span className="grow" />
              <button type="button" className="link" onClick={onToNote}>摘到笔记</button>
              <button type="button" className="icon-btn tool" aria-label="复制原文" title="复制原文" onClick={onCopy}><Icon name="copy" size={15} /></button>
              <button type="button" className="icon-btn tool" aria-label="删除批注" title="删除批注" onClick={onRemove}><Icon name="trash" size={15} /></button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
