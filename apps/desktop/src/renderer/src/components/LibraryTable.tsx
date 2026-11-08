import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Paper } from '@paper/core'
import { formatCitation, type CiteStyle } from '@paper/core'
import { Icon, Spinner } from './Icon'
import { PAPER_DRAG_TYPE } from './Sidebar'
import { addedLabel, authorLine, MATCH_HINT } from '../lib/format'
import { api } from '../lib/library'
import { filterPapers } from '../lib/filterPapers'
import { FILES_APP, mod, TRASH } from '../lib/platform'

interface Props {
  label: string
  papers: Paper[]
  tags: { tag: string; count: number }[]
  importing: Set<string>
  downloading: Set<string>
  /** 选中的论文，右边详情栏显示它 */
  selected: string | null
  onSelect: (id: string | null) => void
  /** 打开阅读（没有 PDF 时只选中） */
  onRead: (id: string) => void
  onRemove: (id: string) => void
  onToast: (text: string) => void
}

/** 行高（和 .td 一致）。论文多的时候只画看得见的那些行 */
const ROW = 60
const VIRTUAL_FROM = 200
const OVERSCAN = 20

const STYLES: [CiteStyle, string][] = [['apa', 'APA'], ['gbt7714', 'GB/T 7714'], ['bibtex', 'BibTeX']]

/** 论文表格：点一下选中、右边看详情，双击或回车开始读；可以筛选、拖到文件夹 */
/** 两次点击算双击的间隔；单击要等这么久才打开详情 */
const DOUBLE_CLICK_MS = 250

export function LibraryTable({ label, papers, tags, importing, downloading, selected: sel, onSelect: setSel, onRead, onRemove, onToast }: Props) {
  const [q, setQ] = useState('')
  /** 右键菜单：哪一篇、在哪里弹出 */
  const [menu, setMenu] = useState<{ p: Paper; x: number; y: number } | null>(null)

  useEffect(() => {
    if (!menu) return
    const away = (e: PointerEvent) => !(e.target as HTMLElement).closest?.('.row-menu') && setMenu(null)
    const esc = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), setMenu(null))
    const close = () => setMenu(null)
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', esc, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', esc, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [menu])

  const copyCite = (p: Paper, style: CiteStyle, name: string) => {
    setMenu(null)
    navigator.clipboard.writeText(formatCitation(p, style)).then(() => onToast(`已复制 ${name} 引用`), () => onToast('没能复制，请再试一次'))
  }
  const exportOne = (p: Paper, format: 'bibtex' | 'ris') => {
    setMenu(null)
    void api.library.exportCitations([p.id], format).then((ok) => ok && onToast('已导出'))
  }
  const [tag, setTag] = useState('')

  // 单击先只把行标亮，等一下确认不是双击再打开详情；双击直接去读，中间不闪一下详情栏
  const [lit, setLit] = useState<string | null>(null)
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 这次聚焦是鼠标按下带来的（键盘聚焦才立刻选中） */
  const byPointer = useRef(false)
  const cancelClick = () => {
    if (clickTimer.current) clearTimeout(clickTimer.current)
    clickTimer.current = null
  }
  useEffect(() => setLit(null), [sel])
  useEffect(() => cancelClick, [])
  const clickRow = (id: string, count: number) => {
    if (count > 1 || id === sel) return
    setLit(id)
    cancelClick()
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null
      setSel(id)
    }, DOUBLE_CLICK_MS)
  }
  const shownSel = lit ?? sel
  /** 去读这篇：回来时这一行还标亮着，知道刚才读到哪 */
  const read = (id: string) => {
    cancelClick()
    setLit(id)
    onRead(id)
  }

  const rows = useMemo(() => filterPapers(papers, q, tag), [papers, q, tag])
  const group = useRef<HTMLDivElement>(null)
  const virtual = rows.length > VIRTUAL_FROM
  const [win, setWin] = useState({ start: 0, end: 60 })

  // 只画滚动区域里看得见的行，上下各多画一些；1 万篇也不卡
  useLayoutEffect(() => {
    if (!virtual) return
    const g = group.current
    const sc = g?.closest('.main') as HTMLElement | null
    if (!g || !sc) return
    const update = () => {
      const top = g.getBoundingClientRect().top - sc.getBoundingClientRect().top
      const first = Math.floor(-top / ROW)
      const start = Math.max(0, first - OVERSCAN)
      const end = Math.min(rows.length, Math.max(0, first) + Math.ceil(sc.clientHeight / ROW) + OVERSCAN)
      setWin((w) => (w.start === start && w.end === end ? w : { start, end }))
    }
    update()
    sc.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      sc.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [virtual, rows.length])
  const shown = virtual ? rows.slice(win.start, win.end) : rows

  /** 键盘选到还没画出来的行：先滚过去，画出来后再聚焦 */
  const reveal = (i: number, id: string) => {
    const g = group.current
    const sc = g?.closest('.main') as HTMLElement | null
    if (virtual && g && sc) {
      const rowTop = g.getBoundingClientRect().top - sc.getBoundingClientRect().top + i * ROW
      if (rowTop < 0) sc.scrollTop += rowTop
      else if (rowTop + ROW > sc.clientHeight) sc.scrollTop += rowTop + ROW - sc.clientHeight
    }
    requestAnimationFrame(() => document.getElementById(`row-${id}`)?.focus({ preventScroll: virtual }))
  }

  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    // 以有焦点的那一行为准（刚点过的行，选中状态可能还没更新）
    const focusedId = (e.target as HTMLElement).id?.startsWith('row-') ? (e.target as HTMLElement).id.slice(4) : sel
    const i = rows.findIndex((r) => r.id === focusedId)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (next) {
        setSel(next.id)
        reveal(rows.indexOf(next), next.id)
      }
    }
    if (e.key === 'Enter' && focusedId) read(focusedId)
    if (e.key === 'Escape' && sel) setSel(null)
    if ((e.key === 'Backspace' || e.key === 'Delete') && mod(e) && sel) onRemove(sel)
  }

  return (
    <section className="tray" aria-labelledby="h-list" onKeyDown={onKey}>
      <div className="tray-h tray-h-row">
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <h2 id="h-list" className="lbl" style={{ margin: 0 }}>{label}</h2>
          <span className="big num">{rows.length === papers.length ? `${papers.length} 篇` : `${rows.length} / ${papers.length} 篇`}</span>
        </div>
        {tags.length > 0 && (
          <label className="select">
            <span className="sr">按标签筛选</span>
            <select value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">全部标签</option>
              {tags.map((t) => <option key={t.tag} value={t.tag}>{t.tag}（{t.count}）</option>)}
            </select>
            <Icon name="down" size={14} />
          </label>
        )}
        <label className="filter">
          <Icon name="search" size={16} />
          <span className="sr">筛选论文</span>
          <input type="text" placeholder="筛选标题、作者、标签" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')} />
        </label>
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <div role="table" aria-label="论文列表" aria-rowcount={rows.length}>
          <div role="row" className="tr th">
            <span role="columnheader">论文</span>
            <span role="columnheader">来源</span>
            <span role="columnheader" className="r">加入时间</span>
          </div>
          <div role="rowgroup" ref={group}>
            {virtual && win.start > 0 && <div aria-hidden="true" style={{ height: win.start * ROW }} />}
            {shown.map((p, k) => {
              const busy = importing.has(p.id)
              const sub = busy ? '正在识别标题和作者…' : downloading.has(p.id) ? [authorLine(p), p.year, '正在下载 PDF…'].filter(Boolean).join(' · ') : p.needsMatch && p.matchIssue ? MATCH_HINT[p.matchIssue] : [authorLine(p), p.year].filter(Boolean).join(' · ') || '没有作者信息'
              return (
                <div
                  key={p.id}
                  id={`row-${p.id}`}
                  role="row"
                  aria-rowindex={(virtual ? win.start : 0) + k + 2}
                  tabIndex={0}
                  className={'tr td' + (shownSel === p.id ? ' sel' : '')}
                  aria-selected={shownSel === p.id}
                  onPointerDown={() => (byPointer.current = true)}
                  onClick={(e) => clickRow(p.id, e.detail)}
                  onDoubleClick={() => read(p.id)}
                  onFocus={() => {
                    if (byPointer.current) byPointer.current = false
                    else setSel(p.id)
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    cancelClick()
                    setSel(p.id)
                    setMenu({ p, x: Math.min(e.clientX, window.innerWidth - 216), y: Math.min(e.clientY, window.innerHeight - 330) })
                  }}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(PAPER_DRAG_TYPE, p.id)
                    e.dataTransfer.effectAllowed = 'link'
                  }}
                >
                  <div role="cell" className="cell-paper">
                    <span className={'thumb' + (p.files.length ? '' : ' nofile')} aria-hidden="true">{busy || downloading.has(p.id) ? <Spinner /> : <Icon name="file" size={14} />}</span>
                    <span className="rt">
                      <b className="row-title" title={p.title}>{p.title}</b>
                      <small className={p.needsMatch && !busy ? 'warn-text' : undefined}>{sub}</small>
                    </span>
                    {p.files.length > 0 && (
                      <button type="button" className="btn btn-s row-read" tabIndex={-1} title="开始读（双击或回车也可以）" onClick={(e) => { e.stopPropagation(); read(p.id) }} onDoubleClick={(e) => e.stopPropagation()}>
                        <Icon name="reading" size={14} />读
                      </button>
                    )}
                  </div>
                  <div role="cell" className="cell-muted" title={p.venue}>{p.venue ?? '—'}</div>
                  <div role="cell" className="r cell-muted num">{addedLabel(p.addedAt)}</div>
                </div>
              )
            })}
            {virtual && win.end < rows.length && <div aria-hidden="true" style={{ height: (rows.length - win.end) * ROW }} />}
            {rows.length === 0 && (
              <div className="table-empty">
                {papers.length === 0 ? '这里还没有论文。' : '没有符合筛选条件的论文。'}
                {(q || tag) && <button type="button" className="link" onClick={() => { setQ(''); setTag('') }}>清除筛选</button>}
              </div>
            )}
          </div>
        </div>
      </div>
      {menu && (
        <div className="menu row-menu" role="menu" aria-label={menu.p.title} style={{ left: menu.x, top: menu.y }} onContextMenu={(e) => e.preventDefault()}>
          {menu.p.files.length > 0 && <button type="button" role="menuitem" onClick={() => { setMenu(null); read(menu.p.id) }}>开始读</button>}
          {menu.p.files.length > 0 && <button type="button" role="menuitem" onClick={() => { setMenu(null); void api.library.showInFinder(menu.p.id) }}>在访达中显示 PDF</button>}
          {menu.p.files.length > 0 && <div className="menu-sep" role="separator" />}
          <p className="menu-sub-h">复制引用</p>
          {STYLES.map(([s, name]) => <button key={s} type="button" role="menuitem" onClick={() => copyCite(menu.p, s, name)}>{name}</button>)}
          <div className="menu-sep" role="separator" />
          <button type="button" role="menuitem" onClick={() => exportOne(menu.p, 'bibtex')}>导出 BibTeX…</button>
          <button type="button" role="menuitem" onClick={() => exportOne(menu.p, 'ris')}>导出 RIS…</button>
          <div className="menu-sep" role="separator" />
          <button type="button" role="menuitem" className="danger" onClick={() => { setMenu(null); onRemove(menu.p.id) }}>移到{TRASH}</button>
        </div>
      )}
    </section>
  )
}
