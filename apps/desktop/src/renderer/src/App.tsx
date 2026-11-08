import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type { MenuCommand } from '../../shared/api'
import { Sidebar, PAPER_DRAG_TYPE } from './components/Sidebar'
import { EmptyLibrary } from './components/EmptyLibrary'
import { LibraryTable } from './components/LibraryTable'
import { PaperDetail } from './components/PaperDetail'
import { Notices, type Toast } from './components/Notices'
import { Icon } from './components/Icon'
import { Reader } from './reader/Reader'
import { NotesView } from './components/NotesView'
import { SettingsView } from './components/SettingsView'
import { Shortcuts } from './components/Shortcuts'
import { TermsView } from './components/TermsView'
import { useNotes } from './lib/notes'
import { warmUp } from './reader/pdf'
import { api, papersIn, useLibrary, type View } from './lib/library'

const TITLES: Record<string, string> = {
  all: '全部论文', terms: '术语', notes: '笔记', settings: '设置'
}
const LIST_LABEL: Record<string, string> = {
  all: '全部'
}

let toastKey = 0

export function App() {
  const lib = useLibrary()
  const { notes } = useNotes()
  /** 笔记页里打开的那篇 */
  const [noteId, setNoteId] = useState<string | null>(null)
  /** 阅读器打开后要跳到的批注 */
  const [jump, setJump] = useState<{ id: string; n: number } | undefined>(undefined)
  const [view, setView] = useState<View>('all')
  /** 选中的论文：列表里高亮，右边显示详情 */
  const [selId, setSelId] = useState<string | null>(null)
  const [readingId, setReadingId] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [dragging, setDragging] = useState(false)
  const [keys, setKeys] = useState(false)
  /** 重新选了 PDF 后让阅读器从头加载 */
  const [reloads, setReloads] = useState(0)

  const toast = useCallback((t: Omit<Toast, 'key'>) => setToasts((l) => [...l, { ...t, key: ++toastKey }]), [])
  const dismissToast = useCallback((key: number) => setToasts((l) => l.filter((t) => t.key !== key)), [])
  const importing = useMemo(() => new Set(lib.importing), [lib.importing])
  const downloading = useMemo(() => new Set(lib.downloading), [lib.downloading])

  const counts = useMemo(() => {
    const c: Partial<Record<View, number>> = { all: lib.papers.length, notes: notes.length, terms: lib.terms.length }
    for (const f of lib.folders) c[`folder:${f.id}`] = papersIn(`folder:${f.id}`, lib.papers).length
    return c
  }, [lib.papers, lib.folders, lib.terms.length, notes.length])

  const folder = view.startsWith('folder:') ? lib.folders.find((f) => `folder:${f.id}` === view) : undefined
  const title = folder?.name ?? TITLES[view] ?? ''
  const selected = selId ? lib.papers.find((p) => p.id === selId) : undefined
  const reading = readingId ? lib.papers.find((p) => p.id === readingId && p.files.length > 0) : undefined
  /** 有 PDF 就进阅读器，没有就只选中、在详情里看怎么拿到 PDF。
   *  进阅读器不打开详情：读完回来文献库还是原样（详情本来开着就跟着换到这篇） */
  const openPaper = (id: string) => {
    const p = lib.papers.find((x) => x.id === id)
    if (!p?.files.length || selId) setSelId(id)
    if (p?.files.length) setReadingId(id)
  }

  // 删掉的文件夹或论文不再停在当前页
  useEffect(() => {
    if (view.startsWith('folder:') && lib.loaded && !folder) setView('all')
  }, [view, folder, lib.loaded])
  useEffect(() => {
    if (selId && lib.loaded && !selected) setSelId(null)
  }, [selId, selected, lib.loaded])
  useEffect(() => {
    if (readingId && lib.loaded && !reading) setReadingId(null)
  }, [readingId, reading, lib.loaded])

  const importFiles = (files: File[]) => {
    const paths = files.filter((f) => f.name.toLowerCase().endsWith('.pdf') || f.type === 'application/pdf').map((f) => api.pathForFile(f)).filter(Boolean)
    if (paths.length) void api.library.importPaths(paths)
    else if (files.length) toast({ text: '只支持 PDF 文件' })
  }

  /** [[链接]]：有这篇就打开，没有就新建一篇（和 Obsidian 一样） */
  const openNoteTitle = async (title: string) => {
    const t = title.toLowerCase()
    const found = notes.find((n) => n.title.toLowerCase() === t) ?? (await api.notes.create({ title }))
    setReadingId(null)
    setView('notes')
    setNoteId(found.id)
  }
  /** 笔记里的引用块：打开那篇论文并跳到这条批注 */
  const openAnnotation = async (id: string) => {
    const a = await api.library.annotation(id)
    if (!a) return toast({ text: '这条批注已经删掉了' })
    setSelId(a.paperId)
    setReadingId(a.paperId)
    setJump((j) => ({ id, n: (j?.n ?? 0) + 1 }))
  }

  const remove = (id: string) => {
    const p = lib.papers.find((x) => x.id === id)
    void api.library.remove(id)
    toast({ text: `已移到废纸篓：${p?.title ?? ''}`, action: { label: '撤销', run: () => void api.library.restore(id) } })
  }

  // 菜单栏
  const onMenu = useRef<(c: MenuCommand) => void>(() => {})
  onMenu.current = (c) => {
    if (c === 'shortcuts') return setKeys(true)
    // 阅读器右边的两栏：只在读论文时有用
    if (c === 'toggleNotes' || c === 'toggleAi') return void (readingId && window.dispatchEvent(new CustomEvent('reader-cmd', { detail: c })))
    if (c === 'importPdf') return void api.library.pickAndImport()
    if (c === 'importBib') return void api.library.importBibTeX()
    if (c === 'exportBib' || c === 'exportRis') {
      if (!lib.papers.length) return toast({ text: '库里还没有论文' })
      return void api.library.exportCitations([], c === 'exportBib' ? 'bibtex' : 'ris').then((ok) => ok && toast({ text: `已导出 ${lib.papers.length} 篇` }))
    }
    setReadingId(null)
    if (c === 'settings') return setView('settings')
    if (c === 'newNote') {
      void api.notes.create({}).then((n) => {
        setView('notes')
        setNoteId(n.id)
      })
    }
  }
  useEffect(() => api.onMenu((c) => onMenu.current(c)), [])

  // 更新：下好了提示重启；手动检查的结果也告诉用户
  const toldUpdate = useRef('')
  useEffect(() => {
    return api.update.onState((st) => {
      if (st.kind === 'ready' && toldUpdate.current !== st.version) {
        toldUpdate.current = st.version
        toast({ text: `新版本 ${st.version} 已经下载好`, action: { label: '重启更新', run: () => void api.update.install() } })
      } else if (st.manual && view !== 'settings') {
        // 在设置页里点的，结果就显示在那一行，不再弹提示
        if (st.kind === 'latest') toast({ text: '已经是最新版本' })
        else if (st.kind === 'downloading' && st.percent === undefined) toast({ text: `发现新版本 ${st.version}，正在后台下载` })
        else if (st.kind === 'error') toast({ text: `检查更新失败：${st.message}` })
        else if (st.kind === 'dev') toast({ text: '开发版不检查更新' })
      }
    })
  }, [toast, view])

  // 兜底：哪个操作在主进程里出错了又没人处理，至少告诉用户没做成、为什么
  useEffect(() => {
    const onReject = (e: PromiseRejectionEvent) => {
      const r: unknown = e.reason
      const msg = (r instanceof Error ? r.message : typeof r === 'string' ? r : '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      if (!msg || /abort|cancel/i.test(msg)) return
      e.preventDefault()
      toast({ text: `没能完成：${msg}` })
    }
    window.addEventListener('unhandledrejection', onReject)
    return () => window.removeEventListener('unhandledrejection', onReject)
  }, [toast])

  // 第一次打开论文不用等 PDF.js 启动
  useEffect(() => {
    const id = requestIdleCallback(() => warmUp(), { timeout: 2000 })
    return () => cancelIdleCallback(id)
  }, [])

  // 粘贴 DOI 或 arXiv 链接直接添加
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, [contenteditable]')) return
      const text = e.clipboardData?.getData('text/plain')?.trim()
      if (!text) return
      const ok = await api.library.addFromText(text)
      if (!ok) toast({ text: '粘贴的内容里没有找到 DOI 或 arXiv 编号' })
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [toast])

  // Esc 关掉详情
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!selId || readingId || e.key !== 'Escape') return
      if ((e.target as HTMLElement).closest?.('input, textarea, select, [role="dialog"]')) return
      setSelId(null)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [selId, readingId])

  const isFileDrag = (e: DragEvent) => e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes(PAPER_DRAG_TYPE)
  const empty = lib.loaded && lib.papers.length === 0
  const listView = !['terms', 'notes', 'settings'].includes(view)

  return (
    <div
      className="app"
      onDragOver={(e) => { if (isFileDrag(e)) { e.preventDefault(); if (!empty) setDragging(true) } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target || !e.relatedTarget) setDragging(false) }}
      onDrop={(e) => { if (isFileDrag(e)) { e.preventDefault(); setDragging(false); importFiles([...e.dataTransfer.files]) } }}
    >
      <Sidebar
        view={view}
        counts={counts}
        folders={lib.folders}
        onSelect={(v) => setView(v)}
        onCreateFolder={(name) => void api.library.createFolder(name)}
        onRenameFolder={(id, name) => void api.library.renameFolder(id, name)}
        onRemoveFolder={(id) => {
          const f = lib.folders.find((x) => x.id === id)
          void api.library.removeFolder(id)
          toast({ text: `已删除文件夹"${f?.name ?? ''}"，里面的论文还在` })
        }}
        onDropToFolder={(folderId, ids) => {
          for (const id of ids) {
            const p = lib.papers.find((x) => x.id === id)
            if (p && !p.folderIds.includes(folderId)) void api.library.update(id, { folderIds: [...p.folderIds, folderId] })
          }
        }}
      />
      <main className="main">
        <header className="header drag">
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="crumb">{folder ? '文件夹' : listView ? '文献库' : view === 'settings' ? '偏好' : '知识'}</div>
            <h1>{title}</h1>
          </div>
          {listView && <button type="button" className="btn btn-p no-drag" onClick={() => void api.library.pickAndImport()}><Icon name="plus" size={16} />导入 PDF</button>}
        </header>
        {!lib.loaded ? null : view === 'settings' ? (
          <SettingsView onShortcuts={() => setKeys(true)} />
        ) : view === 'notes' ? (
          <NotesView notes={notes} papers={lib.papers} openId={noteId} onOpen={setNoteId} onOpenNoteTitle={(t) => void openNoteTitle(t)} onOpenAnnotation={(id) => void openAnnotation(id)} />
        ) : !listView ? (
          <TermsView terms={lib.terms} papers={lib.papers} onOpenPaper={openPaper} toast={toast} />
        ) : empty && view === 'all' ? (
          <EmptyLibrary onFiles={importFiles} onPick={() => void api.library.pickAndImport()} onZotero={() => void api.library.importBibTeX()} onOpenSettings={() => setView('settings')} />
        ) : (
          <LibraryTable
            key={view}
            label={folder ? `文件夹里的论文` : LIST_LABEL[view] ?? ''}
            papers={papersIn(view, lib.papers)}
            tags={lib.tags}
            importing={importing}
            downloading={downloading}
            selected={selId}
            onSelect={setSelId}
            onRead={openPaper}
            onRemove={remove}
            onToast={(text) => toast({ text })}
          />
        )}
      </main>
      {selected && listView && (
        <PaperDetail
          key={selected.id}
          paper={selected}
          folders={lib.folders}
          allTags={lib.tags}
          busy={importing.has(selected.id)}
          downloading={downloading.has(selected.id)}
          onClose={() => setSelId(null)}
          onRead={() => setReadingId(selected.id)}
          onRemove={remove}
        />
      )}
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-card"><Icon name="upload" size={28} /><span>松开导入 PDF</span></div>
        </div>
      )}
      {reading && <Reader key={`${reading.id}:${reloads}`} onReloadFile={() => setReloads((n) => n + 1)} paper={reading} backLabel={title} onBack={() => setReadingId(null)} onInfo={() => { setSelId(reading.id); setReadingId(null); setView('all') }} toast={toast} notes={notes} jump={jump} onOpenNoteTitle={(t) => void openNoteTitle(t)} onOpenAnnotation={(id) => void openAnnotation(id)} onOpenSettings={() => { setReadingId(null); setView('settings') }} terms={lib.terms} />}
      {keys && <Shortcuts onClose={() => setKeys(false)} />}
      <Notices notices={lib.notices} toasts={toasts} dismiss={lib.dismiss} dismissToast={dismissToast} onShowPaper={(id) => { setReadingId(null); setView('all'); setSelId(id) }} />
    </div>
  )
}
