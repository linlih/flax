// 选中文字、右键"翻译"弹出的卡片：只把这段文字（和其中出现的术语译法）发给选中的模型，译文流式显示。
// 选的是一个词或短语时，可以把它加进术语表，之后翻译都按这个译法。
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Term } from '@paper/core'
import { Icon, Spinner } from '../components/Icon'
import { stream } from '../lib/ai'
import { api } from '../lib/library'

/** 多长以内算"词或短语"，可以加进术语表 */
const TERM_MAX = 60

export function TranslateCard({ text, at, paperId, terms, onClose, onOpenSettings, toast }: {
  text: string
  at: { x: number; y: number }
  paperId: string
  terms: Term[]
  onClose: () => void
  onOpenSettings: () => void
  toast: (t: { text: string }) => void
}) {
  const [out, setOut] = useState('')
  const [state, setState] = useState<'busy' | 'done' | { error: string; noKey: boolean }>('busy')
  const [adding, setAdding] = useState<{ term: string; translation: string } | null>(null)
  const id = useRef<string | null>(null)
  const root = useRef<HTMLDivElement>(null)

  const short = text.length <= TERM_MAX && !/[\n。．.!?！？;；]\s*\S/.test(text)
  const known = short ? terms.find((t) => t.term.toLowerCase() === text.replace(/\s+/g, ' ').trim().toLowerCase()) : undefined

  useEffect(() => {
    let alive = true
    void stream(() => api.ai.translate(text), {
      onDelta: (_, all) => alive && setOut(all),
      onDone: (e) => alive && (setOut(e.text), setState('done')),
      onError: (e) => alive && setState({ error: e.code === 'cancelled' ? '已停止' : e.message, noKey: e.code === 'no_key' })
    })
      .then((rid) => (id.current = rid))
      .catch((e: unknown) => alive && setState({ error: e instanceof Error ? e.message : String(e), noKey: false }))
    return () => {
      alive = false
      if (id.current) void api.ai.cancel(id.current)
    }
  }, [text])

  useEffect(() => {
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && onClose()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose())
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', esc, true)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', esc, true)
    }
  }, [onClose])

  const firstLine = out.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const save = async () => {
    if (!adding?.term.trim() || !adding.translation.trim()) return
    await api.library.addTerm({ term: adding.term, translation: adding.translation, paperId })
    setAdding(null)
    toast({ text: known ? '已更新术语表' : '已加入术语表，之后翻译都按这个译法' })
  }

  return (
    <div ref={root} className="reader-float trans-card" style={{ left: at.x, top: at.y + 8 } as CSSProperties} role="dialog" aria-label="翻译">
      {known && <p className="trans-known"><span>术语表</span>{known.translation}</p>}
      <div className="trans-out" aria-live="polite">
        {typeof state === 'object' ? (
          <p className="ai-error">
            {state.error}
            {state.noKey && <button type="button" className="link" onClick={() => { onClose(); onOpenSettings() }}>去设置</button>}
          </p>
        ) : out ? (
          out.split('\n').filter((l) => l.trim()).map((l, i) => <p key={i} className={i > 0 && short ? 'trans-note' : undefined}>{l}</p>)
        ) : (
          <p className="hint"><Spinner /></p>
        )}
      </div>
      {adding ? (
        <form className="trans-add" onSubmit={(e) => { e.preventDefault(); void save() }}>
          <input className="input" aria-label="原文" value={adding.term} onChange={(e) => setAdding({ ...adding, term: e.target.value })} spellCheck={false} />
          <input className="input" aria-label="译法" value={adding.translation} onChange={(e) => setAdding({ ...adding, translation: e.target.value })} autoFocus />
          <div className="anno-card-row">
            <span className="grow" />
            <button type="button" className="btn btn-s" onClick={() => setAdding(null)}>取消</button>
            <button type="submit" className="btn btn-s btn-p" disabled={!adding.term.trim() || !adding.translation.trim()}>保存</button>
          </div>
        </form>
      ) : (
        <div className="anno-card-row">
          {state === 'done' && short && (
            <button type="button" className="link" onClick={() => setAdding({ term: text.replace(/\s+/g, ' ').trim(), translation: known?.translation ?? firstLine })}>
              {known ? '改译法' : '加入术语表'}
            </button>
          )}
          <span className="grow" />
          {state === 'busy' && id.current && <button type="button" className="icon-btn tool" aria-label="停止" title="停止" onClick={() => id.current && void api.ai.cancel(id.current)}><Icon name="stop" size={16} /></button>}
          {state === 'done' && <button type="button" className="icon-btn tool" aria-label="复制译文" title="复制译文" onClick={() => void navigator.clipboard.writeText(out.trim()).then(() => toast({ text: '已复制' }))}><Icon name="copy" size={16} /></button>}
          <button type="button" className="icon-btn tool" aria-label="关闭" title="关闭（Esc）" onClick={onClose}><Icon name="close" size={16} /></button>
        </div>
      )}
    </div>
  )
}
