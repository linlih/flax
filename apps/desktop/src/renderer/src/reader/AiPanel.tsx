// 阅读器右栏的 AI 标签：就是一个对话框。不会自己去读论文；
// 在论文里选中一段、点"问 AI"（或右键），那段文字挂在输入框上，跟问题一起发出去。
import { useEffect, useRef, useState } from 'react'
import { stripCitations } from '@paper/core'
import type { AiChatTurn, AiStatus } from '../../../shared/api'
import { AiText } from '../components/AiText'
import { Icon, Spinner } from '../components/Icon'
import { ModelPicker } from '../components/ModelPicker'
import { stream, usableServices } from '../lib/ai'
import { api } from '../lib/library'

interface Props {
  paperId: string
  status: AiStatus | null
  /** 从论文里选中、拿来问的文字；n 变了就重新挂一次 */
  quote: { text: string; n: number } | null
  onCite: (page: number, quote: string) => void
  onOpenSettings: () => void
  onToNote: (markdown: string) => void
}

export function AiPanel({ paperId, status, quote, onCite, onOpenSettings, onToNote }: Props) {
  const [turns, setTurns] = useState<AiChatTurn[]>([])
  const [live, setLive] = useState<{ id: string | null; text: string } | null>(null)
  const [input, setInput] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let alive = true
    void api.ai.conversation(paperId).then((t) => alive && setTurns(t))
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
      <div className="ai-panel ai-empty" role="tabpanel">
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
        },
        onError: (e) => failed(e.code === 'cancelled' ? '已停止' : e.message)
      })
      setLive((l) => (l ? { ...l, id } : l))
    } catch (e) {
      failed(e instanceof Error ? e.message : String(e))
    }
  }

  const reset = async () => {
    await api.ai.resetConversation(paperId)
    setTurns([])
  }

  const lastUser = [...turns].reverse().find((t) => t.role === 'user')

  return (
    <div className="ai-panel" role="tabpanel">
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
                    <button type="button" className="icon-btn tool" aria-label="摘到笔记" title="摘到笔记" onClick={() => onToNote(stripCitations(t.text))}><Icon name="notes" size={14} /></button>
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
            <span className="grow" />
            {turns.length > 0 && !busy && <button type="button" className="link ai-new" onClick={() => void reset()}>新对话</button>}
            {busy ? (
              <button type="button" className="icon-btn ai-send" aria-label="停止" title="停止" onClick={() => live?.id && void api.ai.cancel(live.id)}><Icon name="stop" size={16} /></button>
            ) : (
              <button type="button" className="icon-btn ai-send" aria-label="发送" title="发送（↩）" disabled={!input.trim() || !ready} onClick={() => void send()}><Icon name="send" size={16} /></button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
