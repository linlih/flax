import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Folder, Paper, ReadingStatus, TagColor } from '@flax/core'
import { tagColorMap } from '../lib/tags'
import { formatCitation, type CiteStyle } from '@flax/core'
import { Icon, Spinner } from './Icon'
import { PAPER_DRAG_TYPE } from './Sidebar'
import { addedLabel, authorLine, MATCH_HINT, STATUS_LABEL } from '../lib/format'
import { isNew, isStale, progress, sortReading, STATUS_ICON, STATUSES } from '../lib/status'
import { api } from '../lib/library'
import { filterPapers } from '../lib/filterPapers'
import { FILES_APP, mod, TRASH } from '../lib/platform'

interface Props {
  label: string
  papers: Paper[]
  tags: { tag: string; count: number; color?: TagColor }[]
  importing: Set<string>
  downloading: Set<string>
  /** 选中的论文，右边详情栏显示它 */
  selected: string | null
  onSelect: (id: string | null) => void
  /** 打开阅读（没有 PDF 时只选中） */
  onRead: (id: string) => void
  onRemove: (id: string) => void
  onStatus: (id: string, st: ReadingStatus) => void
  /** 在读视图：最近打开的在前，显示读到哪；久没碰的分到最后 */
  reading?: boolean
  /** 显示按阅读状态筛选（全部论文和文件夹里） */
  statusFilter?: boolean
  onToast: (text: string) => void
  /** 多选后"加到文件夹"用 */
  folders: Folder[]
  /** 变一次就把光标放进筛选框（侧栏的快速搜索、⌘K） */
  focusFilter?: number
}

type SortKey = 'added' | 'title' | 'venue'
type Sort = { key: SortKey; desc: boolean }

/** 行高（和 .td 一致）。论文多的时候只画看得见的那些行 */
const ROW = 60
const VIRTUAL_FROM = 200
const OVERSCAN = 20

const STYLES: [CiteStyle, string][] = [['apa', 'APA'], ['gbt7714', 'GB/T 7714'], ['bibtex', 'BibTeX']]

/** 论文表格：点一下选中、右边看详情，双击或回车开始读；可以筛选、拖到文件夹 */
/** 两次点击算双击的间隔；单击要等这么久才打开详情 */
const DOUBLE_CLICK_MS = 250

export function LibraryTable({ label, papers, tags, importing, downloading, selected: sel, onSelect: setSel, onRead, onRemove, onStatus, reading = false, statusFilter = false, onToast, folders, focusFilter = 0 }: Props) {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<ReadingStatus | ''>('')
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

  // 点表头排序：默认最新加入的在前。在读视图有自己的顺序（最近打开的在前），不能改
  const [sort, setSort] = useState<Sort>({ key: 'added', desc: true })
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key === 'added' }))
  const rows = useMemo(() => {
    const r = filterPapers(papers, q, tag).filter((p) => !status || p.readingStatus === status)
    if (reading) return sortReading(r)
    const dir = sort.desc ? -1 : 1
    const text = (a: string, b: string) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
    return [...r].sort((a, b) => {
      if (sort.key === 'title') return dir * text(a.title, b.title)
      // 没有来源的不管正序倒序都排在后面
      if (sort.key === 'venue') return !a.venue || !b.venue ? Number(!a.venue) - Number(!b.venue) : dir * text(a.venue, b.venue)
      return dir * a.addedAt.localeCompare(b.addedAt)
    })
  }, [papers, q, tag, status, reading, sort])

  // 多选：⌘ 点加减一篇，⇧ 点选一段，⌘A 全选。选了以后表格上面出现一条批量操作
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const anchor = useRef<string | null>(null)
  const pickedRows = useMemo(() => rows.filter((p) => picked.has(p.id)), [rows, picked])
  const clearPicked = () => setPicked(new Set())
  const pickClick = (id: string, e: { shiftKey: boolean }) => {
    cancelClick()
    if (e.shiftKey && (anchor.current ?? sel)) {
      const a = rows.findIndex((r) => r.id === (anchor.current ?? sel))
      const b = rows.findIndex((r) => r.id === id)
      if (a >= 0 && b >= 0) return setPicked(new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.id)))
    }
    anchor.current = id
    setPicked((s) => {
      const n = new Set(s)
      // 第一次 ⌘ 点：原来选中（开着详情）的那篇也算进来
      if (n.size === 0 && sel && sel !== id) n.add(sel)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }
  const bulk = (patch: (p: Paper) => Parameters<typeof api.library.update>[1] | null, done: string) => {
    let n = 0
    for (const p of pickedRows) {
      const change = patch(p)
      if (change) {
        void api.library.update(p.id, change)
        n++
      }
    }
    onToast(n ? `${done} ${n} 篇` : '这几篇已经是这样了')
  }
  const bulkRemove = () => {
    for (const p of pickedRows) void api.library.remove(p.id)
    onToast(`已把 ${pickedRows.length} 篇移到${TRASH}，可以在侧栏的${TRASH}里放回`)
    clearPicked()
  }
  const [bulkTag, setBulkTag] = useState('')
  const filterInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (focusFilter) filterInput.current?.focus()
  }, [focusFilter])
  /** 在读视图里第一篇"最近没碰"的，前面加一个分隔 */
  const firstStale = reading ? rows.find((p) => isStale(p))?.id : undefined
  const group = useRef<HTMLDivElement>(null)
  const colorOf = useMemo(() => tagColorMap(tags), [tags])
  // 行里放几个标签看列表有多宽：窄的时候少放几个、每个完整显示，其余收进"+N"
  const table = useRef<HTMLDivElement>(null)
  const [tagSlots, setTagSlots] = useState(3)
  useLayoutEffect(() => {
    const el = table.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      const w = e!.contentRect.width
      setTagSlots(w >= 960 ? 3 : w >= 760 ? 2 : 1)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const virtual = !reading && rows.length > VIRTUAL_FROM
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
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return
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
    if (mod(e) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      return setPicked(new Set(rows.map((r) => r.id)))
    }
    if (e.key === 'Escape' && picked.size) {
      e.stopPropagation()
      return clearPicked()
    }
    if (e.key === 'Enter' && focusedId) read(focusedId)
    if (e.key === 'Escape' && sel) setSel(null)
    if ((e.key === 'Backspace' || e.key === 'Delete') && mod(e)) {
      if (pickedRows.length > 1) return bulkRemove()
      if (sel) onRemove(sel)
    }
    // 1–4：把选中的这篇标成 未读 / 待读 / 在读 / 读过（和右键菜单里的顺序一样）
    const st = STATUSES[Number(e.key) - 1]
    if (st && focusedId && !mod(e) && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      onStatus(focusedId, st)
    }
  }

  return (
    <section className="tray" aria-labelledby="h-list" onKeyDown={onKey}>
      <div className="tray-h tray-h-row">
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <h2 id="h-list" className={label ? 'lbl' : 'sr'} style={{ margin: 0 }}>{label || '论文'}</h2>
          <span className="big num">{rows.length === papers.length ? `${papers.length} 篇` : `${rows.length} / ${papers.length} 篇`}</span>
        </div>
        {statusFilter && (
          <label className="select">
            <span className="sr">按阅读状态筛选</span>
            <select value={status} onChange={(e) => setStatus(e.target.value as ReadingStatus | '')}>
              <option value="">全部状态</option>
              {STATUSES.map((st) => <option key={st} value={st}>{STATUS_LABEL[st]}</option>)}
            </select>
            <Icon name="down" size={14} />
          </label>
        )}
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
          <input ref={filterInput} type="text" placeholder="筛选标题、作者、标签" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')} />
        </label>
      </div>
      {pickedRows.length > 0 && (
        <div className="bulk" role="toolbar" aria-label="对选中的论文">
          <b className="num">已选 {pickedRows.length} 篇</b>
          <label className="select">
            <span className="sr">把选中的标为</span>
            <select value="" onChange={(e) => { const st = e.target.value as ReadingStatus; if (st) bulk((p) => (p.readingStatus === st ? null : { readingStatus: st }), `已标为${STATUS_LABEL[st]}`) }}>
              <option value="">标为…</option>
              {STATUSES.map((st) => <option key={st} value={st}>{STATUS_LABEL[st]}</option>)}
            </select>
            <Icon name="down" size={14} />
          </label>
          {folders.length > 0 && (
            <label className="select">
              <span className="sr">把选中的加到文件夹</span>
              <select value="" onChange={(e) => { const f = folders.find((x) => x.id === e.target.value); if (f) bulk((p) => (p.folderIds.includes(f.id) ? null : { folderIds: [...p.folderIds, f.id] }), `已加到"${f.name}"`) }}>
                <option value="">加到文件夹…</option>
                {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
              <Icon name="down" size={14} />
            </label>
          )}
          <label className="filter bulk-tag">
            <span className="sr">给选中的加标签</span>
            <input
              type="text"
              placeholder="加标签，回车"
              value={bulkTag}
              list="bulk-tags"
              onChange={(e) => setBulkTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.key !== 'Enter') return
                const t = bulkTag.trim()
                if (!t) return
                bulk((p) => (p.tags.includes(t) ? null : { tags: [...p.tags, t] }), `已加上标签"${t}"`)
                setBulkTag('')
              }}
            />
            <datalist id="bulk-tags">{tags.map((t) => <option key={t.tag} value={t.tag} />)}</datalist>
          </label>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-s danger-text" onClick={bulkRemove}><Icon name="trash" size={14} />移到{TRASH}</button>
          <button type="button" className="btn btn-s" onClick={clearPicked}>取消选择</button>
        </div>
      )}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div role="table" ref={table} aria-label="论文列表" aria-rowcount={rows.length} aria-multiselectable="true">
          <div role="row" className="tr th">
            {reading ? (
              <>
                <span role="columnheader">论文</span>
                <span role="columnheader">来源</span>
                <span role="columnheader" className="r">上次打开</span>
              </>
            ) : (
              ([['title', '论文', ''], ['venue', '来源', ''], ['added', '加入时间', 'r']] as [SortKey, string, string][]).map(([key, name, cls]) => (
                <span key={key} role="columnheader" className={cls || undefined} aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
                  <button type="button" className="th-sort" title={`按${name}排序`} onClick={() => sortBy(key)}>
                    {name}
                    {sort.key === key && <span className={'th-arrow' + (sort.desc ? '' : ' up')} aria-hidden="true"><Icon name="down" size={12} /></span>}
                  </button>
                </span>
              ))
            )}
          </div>
          <div role="rowgroup" ref={group}>
            {virtual && win.start > 0 && <div aria-hidden="true" style={{ height: win.start * ROW }} />}
            {shown.map((p, k) => {
              const busy = importing.has(p.id)
              const pr = reading ? progress(p) : null
              const sub = pr ? `读到第 ${pr.page} / ${pr.total} 页` : busy ? '正在识别标题和作者…' : downloading.has(p.id) ? [authorLine(p), p.year, '正在下载 PDF…'].filter(Boolean).join(' · ') : p.needsMatch && p.matchIssue ? MATCH_HINT[p.matchIssue] : [authorLine(p), p.year].filter(Boolean).join(' · ') || '没有作者信息'
              return (
                <Fragment key={p.id}>
                {p.id === firstStale && <div className="tr-sep" role="presentation">最近没碰 · 超过 30 天没打开</div>}
                <div
                  id={`row-${p.id}`}
                  role="row"
                  aria-rowindex={(virtual ? win.start : 0) + k + 2}
                  tabIndex={0}
                  className={'tr td' + (shownSel === p.id || picked.has(p.id) ? ' sel' : '') + (reading && isStale(p) ? ' stale' : '')}
                  aria-selected={picked.size ? picked.has(p.id) : shownSel === p.id}
                  onPointerDown={() => (byPointer.current = true)}
                  onClick={(e) => {
                    if (mod(e) || e.shiftKey) return pickClick(p.id, e)
                    if (picked.size) clearPicked()
                    anchor.current = p.id
                    clickRow(p.id, e.detail)
                  }}
                  onDoubleClick={(e) => !mod(e) && !e.shiftKey && read(p.id)}
                  onFocus={() => {
                    if (byPointer.current) byPointer.current = false
                    else setSel(p.id)
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    cancelClick()
                    setSel(p.id)
                    setMenu({ p, x: Math.min(e.clientX, window.innerWidth - 216), y: Math.max(8, Math.min(e.clientY, window.innerHeight - 470)) })
                  }}
                  draggable
                  onDragStart={(e) => {
                    // 拖的是选中的几篇里的一篇：一起拖
                    e.dataTransfer.setData(PAPER_DRAG_TYPE, picked.has(p.id) ? pickedRows.map((x) => x.id).join(',') : p.id)
                    e.dataTransfer.effectAllowed = 'link'
                  }}
                >
                  <div role="cell" className="cell-paper">
                    <span className={`thumb st-${p.readingStatus}` + (p.files.length ? '' : ' nofile')} title={STATUS_LABEL[p.readingStatus]}>
                      {busy || downloading.has(p.id) ? <Spinner /> : <Icon name={p.readingStatus === 'inbox' ? 'file' : STATUS_ICON[p.readingStatus]} size={14} />}
                      {isNew(p) && !busy && <span className="new-dot" />}
                      <span className="sr">{STATUS_LABEL[p.readingStatus]}</span>
                    </span>
                    <span className="rt">
                      <b className={'row-title' + (p.readingStatus === 'done' ? ' read' : '')} title={p.title}>{p.title}</b>
                      <small>{sub}</small>
                      {pr && <span className="row-progress" aria-hidden="true"><i style={{ width: `${Math.round((pr.page / pr.total) * 100)}%` }} /></span>}
                    </span>
                    {p.tags.length > 0 && (
                      <span className="row-tags" title={p.tags.join('、')}>
                        {p.tags.slice(0, tagSlots).map((t) => <span key={t} className={'row-tag' + (colorOf.has(t) ? ` tc tc-${colorOf.get(t)}` : '')}>{t}</span>)}
                        {p.tags.length > tagSlots && <span className="row-tag more">+{p.tags.length - tagSlots}</span>}
                      </span>
                    )}
                  </div>
                  <div role="cell" className="cell-muted" title={p.venue}>{p.venue ?? '—'}</div>
                  <div role="cell" className="r cell-muted num">{addedLabel(reading ? p.lastOpenedAt ?? p.addedAt : p.addedAt)}</div>
                </div>
                </Fragment>
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
          {menu.p.files.length > 0 && <button type="button" role="menuitem" onClick={() => { setMenu(null); read(menu.p.id) }}>{progress(menu.p) ? '继续读' : '开始读'}</button>}
          {menu.p.files.length > 0 && <button type="button" role="menuitem" onClick={() => { setMenu(null); void api.library.showInFinder(menu.p.id) }}>在{FILES_APP}中显示 PDF</button>}
          {menu.p.files.length > 0 && <div className="menu-sep" role="separator" />}
          <p className="menu-sub-h">阅读状态</p>
          {STATUSES.map((st) => (
            <button key={st} type="button" role="menuitemradio" aria-checked={menu.p.readingStatus === st} onClick={() => { setMenu(null); onStatus(menu.p.id, st) }}>{STATUS_LABEL[st]}<kbd>{STATUSES.indexOf(st) + 1}</kbd></button>
          ))}
          <div className="menu-sep" role="separator" />
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
