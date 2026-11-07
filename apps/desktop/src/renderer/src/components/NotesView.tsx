// 侧边栏"笔记"：左边是全部笔记，右边编辑选中的那篇。
import { useMemo, useRef, useState } from 'react'
import type { Paper } from '@paper/core'
import type { NoteSummary } from '../../../shared/api'
import { normalizeTitle } from '@paper/core'
import { editedLabel } from '../lib/notes'
import { Icon } from './Icon'
import { NoteEditor } from './NoteEditor'

interface Props {
  notes: NoteSummary[]
  papers: Paper[]
  openId: string | null
  onOpen: (id: string | null) => void
  onOpenNoteTitle: (title: string) => void
  onOpenAnnotation: (id: string) => void
}

export function NotesView({ notes, papers, openId, onOpen, onOpenNoteTitle, onOpenAnnotation }: Props) {
  const [q, setQ] = useState('')
  const paperTitle = useMemo(() => new Map(papers.map((p) => [p.id, p.title])), [papers])
  const rows = useMemo(() => {
    const nq = normalizeTitle(q)
    if (!nq) return notes
    return notes.filter((n) => {
      const hay = normalizeTitle([n.title, n.excerpt, n.paperId ? paperTitle.get(n.paperId) ?? '' : ''].join(' '))
      return nq.split(' ').every((w) => hay.includes(w))
    })
  }, [notes, q, paperTitle])

  // 没选笔记时右边就是一张空白草稿，直接写；第一次输入才建文件
  const [draftKey, setDraftKey] = useState(0)
  /** 草稿建成的笔记沿用草稿的编辑器，不重建 */
  const born = useRef<{ id: string; key: string } | null>(null)
  const create = () => {
    born.current = null
    setDraftKey((n) => n + 1)
    onOpen(null)
  }
  const editorKey = openId ? (born.current?.id === openId ? born.current.key : openId) : `draft-${draftKey}`
  const showing = !openId || born.current?.id === openId || notes.some((n) => n.id === openId)

  return (
    <div className="notes-view">
      <section className="tray notes-list" aria-labelledby="h-notes">
        <div className="tray-h tray-h-row">
          <div style={{ flex: 1 }}>
            <h2 id="h-notes" className="lbl" style={{ margin: 0 }}>全部笔记</h2>
            <span className="big num">{rows.length === notes.length ? `${notes.length} 篇` : `${rows.length} / ${notes.length} 篇`}</span>
          </div>
          <button type="button" className="btn btn-s" onClick={create}><Icon name="plus" size={14} />新笔记</button>
        </div>
        <label className="filter">
          <Icon name="search" size={16} />
          <span className="sr">筛选笔记</span>
          <input type="text" placeholder="筛选标题、内容、论文" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')} />
        </label>
        <div className="card notes-items" role="listbox" aria-label="笔记">
          {rows.map((n) => (
            <button key={n.id} type="button" role="option" aria-selected={n.id === openId} className={'note-item' + (n.id === openId ? ' sel' : '')} onClick={() => onOpen(n.id)}>
              <b>{n.title}</b>
              {n.excerpt && <span className="note-ex">{n.excerpt}</span>}
              <small>{[editedLabel(n.updatedAt), n.paperId && paperTitle.get(n.paperId) && `论文：${paperTitle.get(n.paperId)}`].filter(Boolean).join(' · ')}</small>
            </button>
          ))}
          {notes.length === 0 && (
            <div className="table-empty">
              还没有笔记。直接在右边写，或者读论文时在右边栏切到"笔记"。
            </div>
          )}
          {notes.length > 0 && rows.length === 0 && <div className="table-empty">没有符合筛选条件的笔记。</div>}
        </div>
      </section>
      <section className="notes-editor">
        {showing ? (
          <NoteEditor
            key={editorKey}
            noteId={openId}
            autoFocus
            onCreated={(id) => { born.current = { id, key: editorKey }; onOpen(id) }}
            notes={notes}
            onOpenNote={onOpenNoteTitle}
            onOpenAnnotation={onOpenAnnotation}
            onDeleted={() => { born.current = null; onOpen(null) }}
            onNew={create}
          />
        ) : (
          <div className="notes-empty hint">这篇笔记的文件不在了。</div>
        )}
      </section>
    </div>
  )
}
