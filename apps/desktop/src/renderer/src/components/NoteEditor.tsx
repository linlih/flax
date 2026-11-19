// 笔记编辑器：所见即所得的 Markdown（见 livePreview.ts），停手半秒自动存盘。
// 还没有文件时也能直接写：第一次输入时才建文件，不留空笔记。
// [[ 补全笔记标题；⌘ 点击 [[链接]] 打开那篇笔记，⌘ 点击引用块里的"第 N 页"跳回原文。
import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap, placeholder, type ViewUpdate } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { headingTitle, isUntitledNote, safeNoteTitle } from '@flax/core'
import type { NoteSummary } from '../../../shared/api'
import { api } from '../lib/library'
import { linkAt } from '../lib/noteLinks'
import { Icon } from './Icon'
import { slashCommands } from './slashMenu'
import { excerptAt, exitEmptyQuote, insertLink, livePreview, pasteLink, toggleTask, toggleWrap } from './livePreview'
import { closeCodeFence, cursorDownSkippingGaps, cursorUpSkippingGaps, joinParagraph, newParagraph, softBreak } from './noteKeys'
import { nextCell, prevCell, tableEnter } from './noteTable'
import { noteBlocks } from './noteBlocks'
import { smartPaste } from './notePaste'
import { composing, FILES_APP, TRASH } from '../lib/platform'

/** 外面可以往正在编辑的笔记里插内容（摘到笔记用） */
export interface EditorHandle {
  noteId: string
  /** 加到文末，光标移过去并滚到可见 */
  append(text: string): void
}

interface Props {
  /** 已有的笔记；没有时是草稿，第一次输入时按 draft 新建 */
  noteId: string | null
  draft?: { paperId?: string; title?: string }
  /** 草稿建成文件后告诉外面新笔记的 id */
  onCreated?: (id: string) => void
  notes: NoteSummary[]
  compact?: boolean
  /** 标题右边放什么；给了就不显示自带的那几个按钮（阅读器的笔记栏把它们收进一个菜单） */
  tools?: ReactNode
  onOpenNote: (title: string) => void
  onOpenAnnotation: (id: string) => void
  onDeleted?: () => void
  handle?: MutableRefObject<EditorHandle | null>
  /** 挂上就把光标放到文末，直接能写 */
  autoFocus?: boolean
  /** 有了就在工具栏放"新笔记" */
  onNew?: () => void
}

const SAVE_DELAY = 500

export function NoteEditor({ noteId: initialId, draft, onCreated, notes, compact, tools, onOpenNote, onOpenAnnotation, onDeleted, handle, autoFocus, onNew }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const [title, setTitle] = useState('')
  const [loaded, setLoaded] = useState<{ updatedAt: string } | null>(null)
  /** 没能写进文件（磁盘满、没有权限…）：内容还在编辑器里，下次输入或点重试会再存 */
  const [saveError, setSaveError] = useState<string | null>(null)
  const retry = useRef<() => void>(() => {})
  const [missing, setMissing] = useState(false)
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const dirty = useRef(false)
  // 回调和标题列表会变，编辑器只建一次，所以经 ref 读最新的
  const latest = useRef({ notes, onOpenNote, onOpenAnnotation, onCreated, draft })
  latest.current = { notes, onOpenNote, onOpenAnnotation, onCreated, draft }
  /** 草稿第一次存盘后才有 id；编辑器不因此重建 */
  const [noteId, setNoteId] = useState<string | null>(initialId)
  const idRef = useRef(initialId)
  const titleRef = useRef('')
  titleRef.current = title
  /** 标题跟着正文第一行的 # 标题走（没起过名字的笔记，或者标题本来就和它一样）；手动改过标题就不跟了 */
  const followHeading = useRef(false)

  const me = noteId ? notes.find((n) => n.id === noteId) : undefined

  // —— 建编辑器、读正文 ——
  useEffect(() => {
    let alive = true
    let creating: Promise<void> | null = null
    let renaming = false
    const save = async () => {
      clearTimeout(pending.current)
      if (!dirty.current || !view.current) return
      if (creating) return void creating.then(() => save())
      dirty.current = false
      const body = view.current.state.doc.toString()
      const failed = (e: unknown) => {
        dirty.current = true
        creating = null
        if (alive) setSaveError(saveErrorText(e))
      }
      if (!idRef.current) {
        if (!body.trim()) return
        const d = latest.current.draft
        creating = api.notes.create({ title: titleRef.current.trim() || d?.title, paperId: d?.paperId, body }).then((n) => {
          idRef.current = n.id
          if (alive) {
            setNoteId(n.id)
            setTitle(n.title)
            setLoaded({ updatedAt: n.updatedAt })
            setSaveError(null)
          }
          if (handle?.current) handle.current.noteId = n.id
          latest.current.onCreated?.(n.id)
          creating = null
          followHeading.current = isUntitledNote(n.title)
          titleRef.current = n.title
          void titleFromHeading(body, false)
        }, failed)
        return creating
      }
      try {
        const saved = await api.notes.save(idRef.current, body)
        if (alive) {
          setLoaded({ updatedAt: saved.updatedAt })
          setSaveError(null)
        }
        await titleFromHeading(body, false)
      } catch (e) {
        failed(e)
      }
    }
    /** 光标还在第一行标题里时先不改名（还在打字），离开那一行或关掉笔记时再改 */
    const titleFromHeading = async (body: string, closing: boolean) => {
      const id = idRef.current
      const want = headingTitle(body)
      if (!id || !followHeading.current || !want) return
      const safe = safeNoteTitle(want)
      // 和别的笔记重名时文件名后面加了数字（"读书笔记 2"），也算对上了
      const cur = titleRef.current.toLowerCase()
      if (cur === safe.toLowerCase() || (cur.startsWith(safe.toLowerCase() + ' ') && /^\d+$/.test(cur.slice(safe.length + 1)))) return
      const ed = view.current
      if (!closing && ed?.hasFocus) {
        const firstLine = ed.state.doc.lineAt(ed.state.doc.toString().search(/\S|$/))
        if (ed.state.selection.main.head <= firstLine.to) return
      }
      if (renaming) return
      renaming = true
      try {
        const r = await api.notes.rename(id, want)
        titleRef.current = r.title
        if (alive) setTitle(r.title)
      } finally {
        renaming = false
      }
    }
    retry.current = () => void save()
    const ed = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: '',
        extensions: [
          history(),
          closeBrackets(),
          // 代码块按语言上色（用到哪种语言才加载哪种）
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          syntaxHighlighting(mdStyle),
          livePreview,
          noteBlocks,
          pasteLink,
          smartPaste,
          highlightSelectionMatches(),
          EditorView.lineWrapping,
          placeholder('直接写。输入 / 插入标题、列表、待办、代码块…，输入 [[ 链接到别的笔记'),
          autocompletion({ override: [(ctx) => completeLinks(ctx, latest.current.notes, idRef.current), slashCommands], icons: false }),
          // 放在补全后面：补全菜单开着时回车是选中那一项
          Prec.highest(
            keymap.of([
              { key: 'Enter', run: (v) => exitEmptyQuote(v) || closeCodeFence(v) || tableEnter(v) || newParagraph(v) },
              { key: 'Shift-Enter', run: softBreak },
              { key: 'Backspace', run: joinParagraph },
              { key: 'Tab', run: nextCell },
              { key: 'Shift-Tab', run: prevCell },
              { key: 'ArrowDown', run: cursorDownSkippingGaps },
              { key: 'ArrowUp', run: cursorUpSkippingGaps }
            ])
          ),
          keymap.of([
            { key: 'Mod-b', run: toggleWrap('**') },
            { key: 'Mod-i', run: toggleWrap('*') },
            { key: 'Mod-e', run: toggleWrap('`') },
            { key: 'Mod-Shift-x', run: toggleWrap('~~') },
            { key: 'Mod-k', run: insertLink },
            { key: 'Mod-l', run: toggleTask },
            ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, ...completionKeymap, indentWithTab
          ]),
          theme,
          EditorView.domEventHandlers({
            mousedown: (e, v) => {
              if (e.button !== 0) return false
              const pos = v.posAtCoords({ x: e.clientX, y: e.clientY })
              if (pos == null) return false
              // 摘录的原文：直接点就跳回论文；光标已经在这一段里（正在改）或按着 ⌥ 时照常编辑
              if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
                const ex = excerptAt(v.state, pos)
                if (ex && !(v.hasFocus && v.state.selection.ranges.some((r) => r.to >= ex.from && r.from <= ex.to))) {
                  e.preventDefault()
                  latest.current.onOpenAnnotation(ex.id)
                  return true
                }
              }
              const hit = linkAt(v.state.doc.lineAt(pos).text, pos - v.state.doc.lineAt(pos).from)
              if (!hit) return false
              // 普通链接要按 ⌘ 才打开（不然没法把光标放进去改）；跳回原文的链接直接点
              if (!(e.metaKey || e.ctrlKey) && hit.kind !== 'annotation') return false
              e.preventDefault()
              if (hit.kind === 'note') latest.current.onOpenNote(hit.target)
              else if (hit.kind === 'annotation') latest.current.onOpenAnnotation(hit.target)
              else window.open(hit.target)
              return true
            }
          }),
          EditorView.updateListener.of((u: ViewUpdate) => {
            // 写完标题、光标离开那一行：改名
            if (!u.docChanged && (u.selectionSet || u.focusChanged) && !dirty.current) void titleFromHeading(u.state.doc.toString(), false)
            if (!u.docChanged || u.transactions.every((tr) => tr.isUserEvent('load'))) return
            dirty.current = true
            clearTimeout(pending.current)
            pending.current = setTimeout(() => void save(), SAVE_DELAY)
          })
        ]
      })
    })
    view.current = ed
    if (idRef.current) {
      void api.notes.read(idRef.current).then((r) => {
        if (!alive) return
        if (!r) return setMissing(true)
        ed.dispatch({ changes: { from: 0, to: ed.state.doc.length, insert: r.body }, userEvent: 'load' })
        setTitle(r.note.title)
        titleRef.current = r.note.title
        followHeading.current = isUntitledNote(r.note.title) || safeNoteTitle(headingTitle(r.body) ?? '') === r.note.title
        setLoaded({ updatedAt: r.note.updatedAt })
        if (autoFocus || !r.body.trim()) {
          ed.dispatch({ selection: { anchor: ed.state.doc.length }, scrollIntoView: true })
          ed.focus()
        }
      })
    } else if (autoFocus) {
      // 草稿：直接可以写
      ed.focus()
    }
    if (handle) {
      handle.current = {
        noteId: idRef.current ?? '',
        append(text) {
          const doc = ed.state.doc
          const sep = doc.length === 0 ? '' : doc.toString().endsWith('\n\n') ? '' : doc.toString().endsWith('\n') ? '\n' : '\n\n'
          const insert = sep + text + '\n'
          ed.dispatch({ changes: { from: doc.length, insert }, selection: { anchor: doc.length + insert.length }, scrollIntoView: true, userEvent: 'input' })
          ed.focus()
        }
      }
    }
    return () => {
      alive = false
      if (handle?.current && handle.current.noteId === (idRef.current ?? '')) handle.current = null
      // 关掉前把没存的存下（草稿也建成文件）
      if (dirty.current) {
        const body = ed.state.doc.toString()
        const d = latest.current.draft
        if (idRef.current) void api.notes.save(idRef.current, body).then(() => titleFromHeading(body, true))
        else if (creating) void creating.then(() => { if (idRef.current) void api.notes.save(idRef.current, body) })
        else if (body.trim()) void api.notes.create({ title: titleRef.current.trim() || d?.title || headingTitle(body) || undefined, paperId: d?.paperId, body })
      } else void titleFromHeading(ed.state.doc.toString(), true)
      clearTimeout(pending.current)
      ed.destroy()
      view.current = null
    }
    // 只在挂载时建编辑器；换笔记由外面换 key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // —— 文件在别处被改了：没有未存的修改时，换成新内容 ——
  useEffect(() => {
    if (!me || !noteId || !loaded || me.updatedAt === loaded.updatedAt || dirty.current) return
    void api.notes.read(noteId).then((r) => {
      const ed = view.current
      if (!r || !ed || dirty.current) return
      if (r.body !== ed.state.doc.toString()) ed.dispatch({ changes: { from: 0, to: ed.state.doc.length, insert: r.body }, userEvent: 'load' })
      setLoaded({ updatedAt: r.note.updatedAt })
    })
    if (me.title !== title) setTitle(me.title)
  }, [me, loaded, noteId, title])

  const rename = async () => {
    const want = title.trim()
    if (!noteId) return
    if (!me || !want || want === me.title) return setTitle(me?.title ?? title)
    const r = await api.notes.rename(noteId, want)
    setTitle(r.title)
    followHeading.current = safeNoteTitle(headingTitle(view.current?.state.doc.toString() ?? '') ?? '') === r.title
  }

  const backlinks = useMemo(() => (me && !compact ? notes.filter((n) => n.id !== me.id && n.links.some((l) => l.toLowerCase() === me.title.toLowerCase())) : []), [notes, me, compact])

  if (missing) return <div className="note-missing hint">这篇笔记已经不在了（可能被移到了{TRASH}）。</div>

  return (
    <div className={'note-ed' + (compact ? ' compact' : '')}>
      <div className="note-ed-head">
        <input
          className="note-title"
          aria-label="笔记标题"
          value={title}
          placeholder={draft?.title || '标题'}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void rename()}
          onKeyDown={(e) => {
            if (composing(e)) return
            if (e.key === 'Enter') { e.preventDefault(); view.current?.focus() }
            if (e.key === 'Escape') { setTitle(me?.title ?? title); view.current?.focus() }
          }}
        />
        <div className="note-tools">
          {tools ?? (noteId && <>
          {onNew && <button type="button" className="icon-btn" aria-label="新笔记" title="新笔记" onClick={onNew}><Icon name="plus" size={16} /></button>}
          <button type="button" className="icon-btn" aria-label={`在${FILES_APP}中显示文件`} title={`在${FILES_APP}中显示（笔记就是普通的 .md 文件）`} onClick={() => void api.notes.showInFinder(noteId)}><Icon name="open" size={16} /></button>
          <button type="button" className="icon-btn" aria-label="删除笔记" title={`移到${TRASH}`} onClick={() => { void api.notes.remove(noteId).then(() => onDeleted?.()) }}><Icon name="trash" size={16} /></button>
          </>)}
        </div>
      </div>
      <div ref={host} className="note-cm" />
      {/* 自动保存不用说；只有没存上时才出来 */}
      {saveError && (
        <div className="note-foot">
          <span className="ai-error" role="alert">没能保存：{saveError}<button type="button" className="link" onClick={() => retry.current()}>重试</button></span>
        </div>
      )}
      {backlinks.length > 0 && (
        <section className="note-backlinks" aria-labelledby="h-back">
          <h3 id="h-back" className="lbl">链接到这里的笔记 · {backlinks.length}</h3>
          {backlinks.map((n) => (
            <button key={n.id} type="button" className="backlink" onClick={() => onOpenNote(n.title)}>
              <b>{n.title}</b>
              {n.excerpt && <small>{n.excerpt}</small>}
            </button>
          ))}
        </section>
      )}
    </div>
  )
}

// —— [[ 补全 ——
function completeLinks(ctx: CompletionContext, notes: NoteSummary[], selfId: string | null): CompletionResult | null {
  const m = ctx.matchBefore(/\[\[[^\]\n|#]*$/)
  if (!m) return null
  const typed = m.text.slice(2).toLowerCase()
  const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2)
  const close = after === ']]' ? '' : ']]'
  return {
    from: m.from + 2,
    filter: false,
    options: notes
      .filter((n) => n.id !== selfId && n.title.toLowerCase().includes(typed))
      .slice(0, 30)
      .map((n) => ({ label: n.title, detail: n.paperId ? '论文笔记' : undefined, apply: n.title + close }))
  }
}

/** 补全菜单等 CodeMirror 自带的样式优先级高，要用它自己的主题机制覆盖 */
const theme = EditorView.theme({
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-ui)', fontSize: '13px', maxHeight: '320px', minWidth: '220px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { display: 'flex', alignItems: 'baseline', padding: '6px 10px', lineHeight: '1.4' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > completion-section': { display: 'block', padding: '8px 10px 2px', fontSize: '11px', fontWeight: '600', color: 'var(--text-2)', borderBottom: '0' },
  '.cm-completionDetail': { marginLeft: 'auto', paddingLeft: '16px', fontStyle: 'normal', fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-2)' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { background: 'var(--accent-soft)', color: 'var(--text)' },
  '.cm-tooltip': { border: '1px solid var(--border)', borderRadius: '10px', background: 'var(--card)', boxShadow: 'var(--shadow-float)', overflow: 'hidden' }
})

/** 实时预览之外的语法颜色：露出来的符号淡一点，代码等宽 */
const mdStyle = HighlightStyle.define([
  { tag: t.heading, fontWeight: '600' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.url, color: 'var(--text-2)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)' },
  { tag: [t.processingInstruction, t.meta], color: 'var(--text-2)' },
  // 代码块里的语法颜色（颜色在 styles.css 里，深色模式另有一套）
  { tag: [t.keyword, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], class: 'tok-kw' },
  { tag: [t.string, t.special(t.string), t.regexp], class: 'tok-str' },
  { tag: [t.number, t.bool, t.null, t.atom], class: 'tok-num' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: 'tok-com' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], class: 'tok-fn' },
  { tag: [t.typeName, t.className, t.namespace], class: 'tok-type' }
])

/** 系统报错换成人话 */
function saveErrorText(e: unknown): string {
  const m = (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  if (/EACCES|EPERM|EROFS/.test(m)) return '没有写入笔记文件夹的权限'
  if (/ENOSPC/.test(m)) return '磁盘空间不够了'
  if (/ENOENT/.test(m)) return '笔记文件夹不见了'
  return m
}
