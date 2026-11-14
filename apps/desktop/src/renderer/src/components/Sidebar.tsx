import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import type { Folder } from '@flax/core'
import { Icon, type IconName } from './Icon'
import type { View } from '../lib/library'
import { composing, isMac, kbd, TRASH } from '../lib/platform'
import { api } from '../lib/library'

// 在读、待读放在最上面：打开应用先看到正在读和接下来要读的
const LIBRARY: { id: View; label: string; icon: IconName }[] = [
  { id: 'reading', label: '在读', icon: 'reading' },
  { id: 'toread', label: '待读', icon: 'toread' },
  { id: 'all', label: '全部论文', icon: 'all' }
]
const KNOWLEDGE: { id: View; label: string; icon: IconName }[] = [
  { id: 'terms', label: '术语', icon: 'terms' },
  { id: 'notes', label: '笔记', icon: 'notes' }
]

export const PAPER_DRAG_TYPE = 'application/x-flax-paper-ids'

interface Props {
  view: View
  counts: Partial<Record<View, number>>
  folders: Folder[]
  onSelect: (v: View) => void
  onCreateFolder: (name: string) => void
  onRenameFolder: (id: string, name: string) => void
  onRemoveFolder: (id: string) => void
  onDropToFolder: (folderId: string, paperIds: string[]) => void
  onSearch: () => void
  /** 同步出了问题，或者还有 PDF 在传：在底部说一声，点了去设置。一切正常时不显示 */
  syncNote?: { text: string; error: boolean } | null
}

export function Sidebar(p: Props) {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [dropOn, setDropOn] = useState<string | null>(null)

  const item = (n: { id: View; label: string; icon: IconName }) => (
    <button key={n.id} type="button" className="side" aria-current={p.view === n.id ? 'page' : undefined} onClick={() => p.onSelect(n.id)}>
      <Icon name={n.icon} />
      <span className="side-l">{n.label}</span>
      <span className="count num">{p.counts[n.id] ?? 0}</span>
    </button>
  )

  const onDrop = (e: DragEvent, folderId: string) => {
    e.preventDefault()
    setDropOn(null)
    const ids = e.dataTransfer.getData(PAPER_DRAG_TYPE)
    if (ids) p.onDropToFolder(folderId, ids.split(','))
  }

  return (
    <nav className="app-sidebar drag" aria-label="侧边栏">
      {!isMac && (
        <button
          type="button"
          className="icon-btn tool app-menu no-drag"
          aria-label="菜单"
          title="菜单"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            void api.popupMenu(r.left, r.bottom + 4)
          }}
        >
          <Icon name="menu" size={18} />
        </button>
      )}
      <button type="button" className="search no-drag" aria-label={kbd('快速搜索（⌘K）')} title="在论文里找：标题、作者、标签" onClick={p.onSearch}>
        <Icon name="search" size={16} />
        <span>快速搜索</span>
        <span className="kbd">{kbd('⌘K')}</span>
      </button>
      <div className="side-scroll no-drag">
        <div className="side-list">{LIBRARY.map(item)}</div>
        <div className="side-list">
          <div className="grp">知识</div>
          {KNOWLEDGE.map(item)}
        </div>
        <div className="side-list">
          <div className="grp">
            <span>文件夹</span>
            <button type="button" className="icon-btn" aria-label="新建文件夹" onClick={() => setAdding(true)}><Icon name="plus" size={14} /></button>
          </div>
          {p.folders.map((f) => {
            const id: View = `folder:${f.id}`
            if (editing === f.id) {
              return <FolderInput key={f.id} initial={f.name} label="文件夹名称" onDone={(name) => { setEditing(null); if (name && name !== f.name) p.onRenameFolder(f.id, name) }} />
            }
            return (
              <div key={f.id} className="side-wrap">
                <button
                  type="button"
                  className={'side' + (dropOn === f.id ? ' drop-on' : '')}
                  aria-current={p.view === id ? 'page' : undefined}
                  onClick={() => p.onSelect(id)}
                  onDoubleClick={() => setEditing(f.id)}
                  onContextMenu={(e) => { e.preventDefault(); setMenu(f.id) }}
                  onDragOver={(e) => { if (e.dataTransfer.types.includes(PAPER_DRAG_TYPE)) { e.preventDefault(); setDropOn(f.id) } }}
                  onDragLeave={() => setDropOn(null)}
                  onDrop={(e) => onDrop(e, f.id)}
                >
                  <Icon name="folder" />
                  <span className="side-l">{f.name}</span>
                  <span className="count num">{p.counts[id] ?? 0}</span>
                </button>
                <button type="button" className="icon-btn side-more" aria-label={`${f.name}的更多操作`} onClick={() => setMenu(menu === f.id ? null : f.id)}><Icon name="more" size={14} /></button>
                {menu === f.id && (
                  <div className="menu" role="menu" onMouseLeave={() => setMenu(null)}>
                    <button type="button" role="menuitem" onClick={() => { setMenu(null); setEditing(f.id) }}>重命名</button>
                    <button type="button" role="menuitem" className="danger" onClick={() => { setMenu(null); p.onRemoveFolder(f.id) }}>删除文件夹</button>
                    <p className="menu-hint">论文不会被删除</p>
                  </div>
                )}
              </div>
            )
          })}
          {adding && <FolderInput initial="" label="新文件夹名称" onDone={(name) => { setAdding(false); if (name) p.onCreateFolder(name) }} />}
          {!adding && p.folders.length === 0 && <p className="side-empty">把论文拖到文件夹里分组。一篇可以在多个文件夹里。</p>}
        </div>
      </div>
      <div className="no-drag">
        {p.syncNote && (
          <button type="button" className={'side side-sync' + (p.syncNote.error ? ' err' : '')} title="打开同步设置" onClick={() => p.onSelect('settings')}>
            <Icon name={p.syncNote.error ? 'warn' : 'sync'} />
            <span className="side-l">{p.syncNote.text}</span>
          </button>
        )}
        {/* 废纸篓里有东西（或者正开着）才显示 */}
        {((p.counts.trash ?? 0) > 0 || p.view === 'trash') && (
          <button type="button" className="side" aria-current={p.view === 'trash' ? 'page' : undefined} onClick={() => p.onSelect('trash')}>
            <Icon name="trash" />
            <span className="side-l">{TRASH}</span>
            <span className="count num">{p.counts.trash ?? 0}</span>
          </button>
        )}
        <button type="button" className="side" aria-current={p.view === 'settings' ? 'page' : undefined} onClick={() => p.onSelect('settings')}>
          <Icon name="settings" />
          <span>设置</span>
        </button>
      </div>
    </nav>
  )
}

function FolderInput({ initial, label, onDone }: { initial: string; label: string; onDone: (name: string) => void }) {
  const [v, setV] = useState(initial)
  // Enter 和失去焦点都会结束编辑，只处理第一次
  const done = useRef(false)
  const finish = (name: string) => {
    if (done.current) return
    done.current = true
    onDone(name)
  }
  const key = (e: KeyboardEvent) => {
    if (composing(e)) return
    if (e.key === 'Enter') finish(v.trim())
    if (e.key === 'Escape') finish('')
  }
  return (
    <label className="side side-input">
      <Icon name="folder" />
      <span className="sr">{label}</span>
      <input autoFocus value={v} placeholder="文件夹名称" onChange={(e) => setV(e.target.value)} onKeyDown={key} onBlur={() => finish(v.trim())} />
    </label>
  )
}
