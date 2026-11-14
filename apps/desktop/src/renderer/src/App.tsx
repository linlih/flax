import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type { MenuCommand, UpdateState } from '../../shared/api'
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
import { AddPaper } from './components/AddPaper'
import { UpdateSheet } from './components/UpdateSheet'
import { TermsView } from './components/TermsView'
import { TrashView } from './components/TrashView'
import { useNotes } from './lib/notes'
import { warmUp } from './reader/pdf'
import { api, papersIn, useLibrary, useSyncStatus, type View } from './lib/library'
import { mod, TRASH } from './lib/platform'
import { STATUS_LABEL } from './lib/format'
import type { ReadingStatus } from '@flax/core'

const TITLES: Record<string, string> = {
  all: '全部论文', reading: '在读', toread: '待读', terms: '术语', notes: '笔记', settings: '设置', trash: TRASH
}
// 列表上面的小字：只在比页面标题多说了点什么的时候才有
const LIST_LABEL: Record<string, string> = { reading: '最近打开的在前' }

let toastKey = 0

export function App() {
  const lib = useLibrary()
  const { notes } = useNotes()
  const sync = useSyncStatus()
  const syncNote = sync?.state === 'error' ? { text: '同步出了问题', error: true } : sync?.files?.left ? { text: `还有 ${sync.files.left} 个 PDF 在同步`, error: false } : null
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
  const [linkOpen, setLinkOpen] = useState(false)
  /** 重新选了 PDF 后让阅读器从头加载 */
  const [reloads, setReloads] = useState(0)
  /** 快速搜索（侧栏的按钮、⌘K）：回到全部论文，光标放进筛选框 */
  const [focusFilter, setFocusFilter] = useState(0)
  const quickSearch = useCallback(() => {
    setReadingId(null)
    setView((v) => (['terms', 'notes', 'settings', 'trash'].includes(v) ? 'all' : v))
    setFocusFilter((n) => n + 1)
  }, [])
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!mod(e) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'k') return
      // 笔记编辑器里 ⌘K 是插入链接
      if ((e.target as HTMLElement).closest?.('.cm-editor')) return
      e.preventDefault()
      quickSearch()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [quickSearch])

  const toast = useCallback((t: Omit<Toast, 'key'>) => setToasts((l) => [...l.filter((o) => !t.group || o.group !== t.group), { ...t, key: ++toastKey }]), [])
  const dismissToast = useCallback((key: number) => setToasts((l) => l.filter((t) => t.key !== key)), [])
  const importing = useMemo(() => new Set(lib.importing), [lib.importing])
  const downloading = useMemo(() => new Set(lib.downloading), [lib.downloading])

  const counts = useMemo(() => {
    const c: Partial<Record<View, number>> = { all: lib.papers.length, reading: papersIn('reading', lib.papers).length, toread: papersIn('toread', lib.papers).length, notes: notes.length, terms: lib.terms.length, trash: lib.trash.length }
    for (const f of lib.folders) c[`folder:${f.id}`] = papersIn(`folder:${f.id}`, lib.papers).length
    return c
  }, [lib.papers, lib.folders, lib.terms.length, lib.trash.length, notes.length])

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

  /** 手动改阅读状态（列表右键、详情栏、阅读器里的"标为读过"），可以撤销 */
  const setStatus = (id: string, st: ReadingStatus) => {
    const p = lib.papers.find((x) => x.id === id)
    if (!p || p.readingStatus === st) return
    const before = p.readingStatus
    void api.library.update(id, { readingStatus: st })
    toast({ group: 'status', text: `已标为${STATUS_LABEL[st]}`, action: { label: '撤销', run: () => void api.library.update(id, { readingStatus: before }) } })
  }
  const remove = (id: string) => {
    const p = lib.papers.find((x) => x.id === id)
    void api.library.remove(id)
    toast({ text: `已移到${TRASH}：${p?.title ?? ''}`, action: { label: '撤销', run: () => void api.library.restore(id) } })
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
    if (c === 'addLink') {
      if (['terms', 'notes', 'settings', 'trash'].includes(view)) setView('all')
      return setLinkOpen(true)
    }
    if (c === 'newNote') {
      void api.notes.create({}).then((n) => {
        setView('notes')
        setNoteId(n.id)
      })
    }
  }
  useEffect(() => api.onMenu((c) => onMenu.current(c)), [])

  // 更新：发现新版本就问用户（同一个版本自动检查只问一次，手动检查每次都问）；手动检查的其他结果也告诉用户
  const [upd, setUpd] = useState<UpdateState>({ kind: 'idle' })
  const [updOpen, setUpdOpen] = useState(false)
  const updOpenRef = useRef(false)
  updOpenRef.current = updOpen
  const askedUpdate = useRef('')
  const [appVersion, setAppVersion] = useState('')
  useEffect(() => void api.info().then((i) => setAppVersion(i.version)), [])
  useEffect(() => {
    return api.update.onState((st) => {
      setUpd(st)
      // 框里只显示这几种状态；别的状态（比如又检查了一次）来了就收起来
      if (!['available', 'downloading', 'ready', 'error'].includes(st.kind)) setUpdOpen(false)
      if (st.kind === 'available' && (st.manual || askedUpdate.current !== st.version)) {
        askedUpdate.current = st.version
        setUpdOpen(true)
      } else if (st.kind === 'error' && st.manual && !updOpenRef.current && view !== 'settings') {
        // 更新框开着就显示在框里；设置页里显示在"关于"那一行
        toast({ text: `更新失败：${st.message}` })
      } else if (st.manual && view !== 'settings') {
        // 在设置页里点的，结果就显示在那一行，不再弹提示
        if (st.kind === 'latest') toast({ text: '已经是最新版本' })
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
  const listView = !['terms', 'notes', 'settings', 'trash'].includes(view)

  return (
    <div
      className={reading ? 'app reading' : 'app'}
      onDragOver={(e) => { if (isFileDrag(e)) { e.preventDefault(); if (!empty) setDragging(true) } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target || !e.relatedTarget) setDragging(false) }}
      onDrop={(e) => { if (isFileDrag(e)) { e.preventDefault(); setDragging(false); importFiles([...e.dataTransfer.files]) } }}
    >
      <Sidebar
        view={view}
        counts={counts}
        folders={lib.folders}
        syncNote={syncNote}
        onSearch={quickSearch}
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
            <div className="crumb">{folder ? '文件夹' : listView || view === 'trash' ? '文献库' : view === 'settings' ? '偏好' : '知识'}</div>
            <h1>{title}</h1>
          </div>
          {listView && <AddPaper open={linkOpen} setOpen={setLinkOpen} />}
        </header>
        {!lib.loaded ? null : view === 'settings' ? (
          <SettingsView onShortcuts={() => setKeys(true)} />
        ) : view === 'notes' ? (
          <NotesView notes={notes} papers={lib.papers} openId={noteId} onOpen={setNoteId} onOpenNoteTitle={(t) => void openNoteTitle(t)} onOpenAnnotation={(id) => void openAnnotation(id)} />
        ) : view === 'trash' ? (
          <TrashView papers={lib.trash} onToast={(text) => toast({ text })} />
        ) : !listView ? (
          <TermsView terms={lib.terms} papers={lib.papers} onOpenPaper={openPaper} toast={toast} />
        ) : empty && view === 'all' ? (
          <EmptyLibrary onFiles={importFiles} onPick={() => void api.library.pickAndImport()} onZotero={() => void api.library.importBibTeX()} onOpenSettings={() => setView('settings')} />
        ) : (
          <LibraryTable
            key={view}
            label={LIST_LABEL[view] ?? ''}
            folders={lib.folders}
            focusFilter={focusFilter}
            papers={papersIn(view, lib.papers)}
            tags={lib.tags}
            importing={importing}
            downloading={downloading}
            selected={selId}
            onSelect={setSelId}
            onRead={openPaper}
            onRemove={remove}
            onStatus={setStatus}
            reading={view === 'reading'}
            statusFilter={view === 'all' || view.startsWith('folder:')}
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
          onStatus={(st) => setStatus(selected.id, st)}
        />
      )}
      {updOpen && <UpdateSheet state={upd} version={appVersion} onClose={() => setUpdOpen(false)} />}
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-card"><Icon name="upload" size={28} /><span>松开导入 PDF</span></div>
        </div>
      )}
      {reading && <Reader key={`${reading.id}:${reloads}`} onReloadFile={() => setReloads((n) => n + 1)} paper={reading} backLabel={title} onBack={() => setReadingId(null)} onInfo={() => { setSelId(reading.id); setReadingId(null); setView('all') }} toast={toast} notes={notes} jump={jump} onOpenNoteTitle={(t) => void openNoteTitle(t)} onOpenAnnotation={(id) => void openAnnotation(id)} onOpenSettings={() => { setReadingId(null); setView('settings') }} terms={lib.terms} onStatus={(st) => setStatus(reading.id, st)} />}
      {keys && <Shortcuts onClose={() => setKeys(false)} />}
      <Notices notices={lib.notices} toasts={toasts} dismiss={lib.dismiss} dismissToast={dismissToast} onShowPaper={(id) => { setReadingId(null); setView('all'); setSelId(id) }} />
    </div>
  )
}
