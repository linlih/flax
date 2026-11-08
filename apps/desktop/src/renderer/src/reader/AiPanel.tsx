// 阅读器右栏的 AI 标签：就是一个对话框。不会自己去读论文；
// 在论文里选中一段、点"问 AI"（或右键），那段文字挂在输入框上，跟问题一起发出去。
import { useEffect, useRef, useState } from 'react'
import { stripCitations } from '@flax/core'
import type { AiChatTurn, AiConversationList, AiStatus } from '../../../shared/api'
import { editedLabel } from '../lib/notes'
import { AiText } from '../components/AiText'
import { Icon, Spinner } from '../components/Icon'
import { ModelPicker } from '../components/ModelPicker'
import { EffortPicker } from '../components/EffortPicker'
import { stream, usableServices } from '../lib/ai'
import { api } from '../lib/library'
import { composing, kbd } from '../lib/platform'

interface Props {
  paperId: string
  status: AiStatus | null
  /** 从论文里选中、拿来问的文字；n 变了就重新挂一次 */
  quote: { text: string; n: number } | null
  onCite: (page: number, quote: string) => void
  onOpenSettings: () => void
  onToNote: (markdown: string) => void
  onHide: () => void
}

export function AiPanel({ paperId, status, quote, onCite, onOpenSettings, onToNote, onHide }: Props) {
  const [turns, setTurns] = useState<AiChatTurn[]>([])
  const [convs, setConvs] = useState<AiConversationList>({ current: null, list: [] })
  const refreshConvs = () => void api.ai.conversations(paperId).then(setConvs)
  const [live, setLive] = useState<{ id: string | null; text: string } | null>(null)
  const [input, setInput] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let alive = true
    void api.ai.conversation(paperId).then((t) => alive && setTurns(t))
    void api.ai.conversations(paperId).then((c) => alive && setConvs(c))
    return () => {
      alive = false
    }
  }, [paperId])

  // 选中一段问 AI：把那段挂在输入框上
  useEffect(() => {
    if (!quote) return
    setPending(quote.text)
    requestAnimationFrame(() => box.current?.focus())
  }, [quote])

  // 新内容出来时滚到底
  useEffect(() => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns.length, live?.text])

  if (!status || usableServices(status).length === 0) {
    return (
      <div className="ai-panel ai-empty">
        <div className="panel-head ai-empty-head">
          <h2 className="panel-title">AI</h2>
          <HideButton onHide={onHide} />
        </div>
        <Icon name="sparkle" size={22} />
        <p>连接 AI 服务后就能在这里提问。</p>
        <button type="button" className="btn btn-p" onClick={onOpenSettings}>{status?.services.length ? '去设置填 Key' : '添加 AI 服务'}</button>
      </div>
    )
  }
  const ready = status.ready
  const busy = live !== null

  const send = async (text = input, withQuote = pending ?? undefined) => {
    const q = text.trim()
    if (!q || busy) return
    setTurns((t) => [...t, { role: 'user', text: q, quote: withQuote, at: new Date().toISOString() }])
    setInput('')
    setPending(null)
    if (box.current) box.current.style.height = 'auto'
    setLive({ id: null, text: '' })
    const failed = (message: string) => {
      setLive(null)
      setTurns((t) => [...t, { role: 'assistant', text: '', error: message, at: new Date().toISOString() }])
    }
    try {
      const id = await stream(() => api.ai.ask(paperId, q, withQuote), {
        onDelta: (_, all) => setLive((l) => (l ? { ...l, text: all } : l)),
        onDone: (e) => {
          setLive(null)
          setTurns((t) => [...t, { role: 'assistant', text: e.text, at: new Date().toISOString() }])
          refreshConvs()
        },
        onError: (e) => failed(e.code === 'cancelled' ? '已停止' : e.message)
      })
      setLive((l) => (l ? { ...l, id } : l))
      // 新对话第一次提问时主进程才建它，标题这时就有了
      refreshConvs()
    } catch (e) {
      failed(e instanceof Error ? e.message : String(e))
    }
  }

  const newChat = async () => {
    await api.ai.newConversation(paperId)
    setTurns([])
    setPending(null)
    refreshConvs()
    requestAnimationFrame(() => box.current?.focus())
  }
  const openChat = async (id: string) => {
    setTurns(await api.ai.openConversation(paperId, id))
    refreshConvs()
  }
  const deleteChat = async (id: string) => {
    await api.ai.deleteConversation(paperId, id)
    if (id === convs.current) setTurns([])
    refreshConvs()
  }
  const renameChat = async (id: string, title: string) => {
    await api.ai.renameConversation(paperId, id, title)
    refreshConvs()
  }

  const lastUser = [...turns].reverse().find((t) => t.role === 'user')

  return (
    <div className="ai-panel">
      <div className="panel-head ai-head">
        <ChatHistory convs={convs} busy={busy} onOpen={(id) => void openChat(id)} onDelete={(id) => void deleteChat(id)} onRename={(id, t) => void renameChat(id, t)} />
        <button type="button" className="icon-btn tool" aria-label="新对话" title="新对话（之前的在左边的历史里）" disabled={busy || (convs.current === null && turns.length === 0)} onClick={() => void newChat()}><Icon name="plus" size={16} /></button>
        <HideButton onHide={onHide} />
      </div>
      <div className="ai-scroll" ref={list}>
        {turns.map((t, i) =>
          t.role === 'user' ? (
            <div key={i} className="ai-q">
              {t.quote && <blockquote>{t.quote}</blockquote>}
              <p>{t.text}</p>
            </div>
          ) : (
            <div key={i} className="ai-a">
              {t.error ? (
                <p className="ai-error">
                  {t.error}
                  {i === turns.length - 1 && lastUser && <button type="button" className="link" onClick={() => void send(lastUser.text, lastUser.quote)}>重试</button>}
                </p>
              ) : (
                <>
                  <AiText text={t.text} onCite={onCite} />
                  <div className="ai-a-foot">
                    <button type="button" className="icon-btn tool" aria-label="复制回答" title="复制" onClick={() => void navigator.clipboard.writeText(stripCitations(t.text))}><Icon name="copy" size={14} /></button>
                    <button type="button" className="link ai-to-note" onClick={() => onToNote(stripCitations(t.text))}>摘到笔记</button>
                  </div>
                </>
              )}
            </div>
          )
        )}
        {live && (
          <div className="ai-a" aria-live="polite">
            {live.text ? <AiText text={live.text} streaming onCite={onCite} /> : <p className="hint ai-busy"><Spinner /></p>}
          </div>
        )}
      </div>

      <div className="ai-input">
        {pending && (
          <div className="ai-pending">
            <span>{pending}</span>
            <button type="button" className="icon-btn tool" aria-label="不带这段文字" onClick={() => setPending(null)}><Icon name="close" size={14} /></button>
          </div>
        )}
        <div className="ai-box">
          <textarea
            ref={box}
            rows={1}
            value={input}
            placeholder={pending ? '关于这段，想问什么？' : '提问…'}
            aria-label="提问"
            onChange={(e) => {
              setInput(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = `${Math.min(160, e.target.scrollHeight)}px`
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <div className="ai-box-row">
            <ModelPicker status={status} onManage={onOpenSettings} />
            <EffortPicker status={status} />
            <span className="grow" />
            {busy ? (
              <button type="button" className="icon-btn ai-send" aria-label="停止" title="停止" onClick={() => live?.id && void api.ai.cancel(live.id)}><Icon name="stop" size={16} /></button>
            ) : (
              <button type="button" className="icon-btn ai-send" aria-label="发送" title={kbd('发送（↩）')} disabled={!input.trim() || !ready} onClick={() => void send()}><Icon name="send" size={16} /></button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function HideButton({ onHide }: { onHide: () => void }) {
  return <button type="button" className="icon-btn tool" aria-label="隐藏 AI" title={kbd('隐藏 AI（⌥⌘A）')} onClick={onHide}><Icon name="close" size={16} /></button>
}

/** 面板顶上：当前对话的标题，点开是这篇论文的全部对话。双击标题可以改名 */
function ChatHistory({ convs, busy, onOpen, onDelete, onRename }: {
  convs: AiConversationList
  busy: boolean
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const current = convs.list.find((c) => c.id === convs.current)

  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), setOpen(false))
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', esc, true)
    return () => {
      window.removeEventListener('pointerdown', away)
      window.removeEventListener('keydown', esc, true)
    }
  }, [open])
  useEffect(() => setConfirm(null), [open])

  if (editing && current && editing === current.id) {
    return (
      <input
        className="input ai-title-edit"
        aria-label="对话标题"
        defaultValue={current.title}
        autoFocus
        onFocus={(e) => e.target.select()}
        onBlur={(e) => { onRename(current.id, e.target.value); setEditing(null) }}
        onKeyDown={(e) => {
          if (composing(e)) return
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') { e.stopPropagation(); setEditing(null) }
        }}
      />
    )
  }

  return (
    <div className="mp ai-hist" ref={root}>
      <button
        type="button"
        className="ai-hist-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={convs.list.length === 0}
        title={current ? `${current.title}（双击改名）` : '这篇论文的 AI 对话'}
        onClick={() => setOpen((o) => !o)}
        onDoubleClick={() => { if (current && !busy) { setOpen(false); setEditing(current.id) } }}
      >
        <span className="ai-hist-title">{current?.title ?? (convs.list.length ? '新对话' : 'AI')}</span>
        {convs.list.length > 0 && <Icon name="down" size={12} />}
      </button>
      {open && (
        <div className="mp-menu down ai-hist-menu" role="listbox" aria-label="这篇论文的 AI 对话">
          <div className="mp-scroll">
            {convs.list.map((c) => (
              <div key={c.id} className="ai-hist-row">
                <button
                  type="button"
                  role="option"
                  aria-selected={c.id === convs.current}
                  className="mp-item ai-hist-item"
                  disabled={busy && c.id !== convs.current}
                  onClick={() => { setOpen(false); if (c.id !== convs.current) onOpen(c.id) }}
                >
                  <span className="ai-hist-name">{c.title}</span>
                  <span className="ai-hist-meta">{c.questions} 个问题 · {editedLabel(c.updatedAt)}</span>
                </button>
                {confirm === c.id ? (
                  <button type="button" className="link danger ai-hist-del" onClick={() => { setConfirm(null); onDelete(c.id) }}>删除</button>
                ) : (
                  <button type="button" className="icon-btn tool ai-hist-trash" aria-label={`删除对话：${c.title}`} title="删除这个对话" disabled={busy && c.id === convs.current} onClick={() => setConfirm(c.id)}><Icon name="trash" size={14} /></button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
