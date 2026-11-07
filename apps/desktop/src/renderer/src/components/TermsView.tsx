// 术语页：读论文时加入的术语都在这里。点译法或备注直接改，翻译时同一个词都按这里的译法。
import { useMemo, useState } from 'react'
import type { Paper, Term } from '@paper/core'
import { Icon } from './Icon'
import { api } from '../lib/library'

export function TermsView({ terms, papers, onOpenPaper, toast }: {
  terms: Term[]
  papers: Paper[]
  onOpenPaper: (id: string) => void
  toast: (t: { text: string; action?: { label: string; run: () => void } }) => void
}) {
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)

  const rows = useMemo(() => {
    const n = q.trim().toLowerCase()
    return n ? terms.filter((t) => [t.term, t.translation, t.note ?? ''].some((s) => s.toLowerCase().includes(n))) : terms
  }, [terms, q])
  const titleOf = (id?: string) => (id ? papers.find((p) => p.id === id)?.title : undefined)

  const remove = (t: Term) => {
    void api.library.removeTerm(t.id)
    toast({ text: `已删除术语：${t.term}`, action: { label: '撤销', run: () => void api.library.restoreTerm(t.id) } })
  }

  return (
    <section className="tray" aria-labelledby="h-terms">
      <div className="tray-h tray-h-row">
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <h2 id="h-terms" className="lbl" style={{ margin: 0 }}>术语表</h2>
          <span className="big num">{rows.length === terms.length ? `${terms.length} 个` : `${rows.length} / ${terms.length} 个`}</span>
        </div>
        {terms.length > 0 && (
          <label className="filter">
            <Icon name="search" size={16} />
            <span className="sr">筛选术语</span>
            <input type="text" placeholder="筛选原文、译法、备注" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')} />
          </label>
        )}
        <button type="button" className="btn" onClick={() => setAdding(true)} disabled={adding}><Icon name="plus" size={16} />添加术语</button>
      </div>

      {adding && <AddTerm onDone={(t) => { setAdding(false); if (t) toast({ text: `已加入：${t.term} → ${t.translation}` }) }} />}

      {terms.length === 0 && !adding ? (
        <div className="card terms-empty">
          <Icon name="terms" size={22} />
          <p>读论文时选中一个词，右键"翻译"，再点"加入术语表"。</p>
          <p className="hint">之后翻译时，同一个词都按这里定的译法，全文一致。</p>
        </div>
      ) : terms.length > 0 && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div role="table" aria-label="术语">
            <div role="row" className="tr th terms-tr">
              <span role="columnheader">原文</span>
              <span role="columnheader">译法</span>
              <span role="columnheader">备注</span>
              <span role="columnheader" className="sr">操作</span>
            </div>
            <div role="rowgroup">
              {rows.map((t) => {
                const from = titleOf(t.paperId)
                return (
                  <div key={t.id} role="row" className="tr terms-tr terms-row">
                    <div role="cell"><Cell value={t.term} label={`${t.term}的原文`} strong onSave={(v) => void api.library.updateTerm(t.id, { term: v })} /></div>
                    <div role="cell"><Cell value={t.translation} label={`${t.term}的译法`} onSave={(v) => void api.library.updateTerm(t.id, { translation: v })} /></div>
                    <div role="cell" className="terms-note">
                      <Cell value={t.note ?? ''} label={`${t.term}的备注`} placeholder="加备注" allowEmpty onSave={(v) => void api.library.updateTerm(t.id, { note: v })} />
                      {from && <button type="button" className="link terms-from" title={from} onClick={() => onOpenPaper(t.paperId!)}>来自 {from}</button>}
                    </div>
                    <div role="cell" className="r">
                      <button type="button" className="icon-btn tool terms-del" aria-label={`删除${t.term}`} title="删除" onClick={() => remove(t)}><Icon name="trash" size={14} /></button>
                    </div>
                  </div>
                )
              })}
              {rows.length === 0 && <div className="table-empty">没有符合的术语。<button type="button" className="link" onClick={() => setQ('')}>清除筛选</button></div>}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

/** 点一下就能改的格子：回车或离开时保存，Esc 放弃 */
function Cell({ value, label, onSave, strong, placeholder, allowEmpty }: { value: string; label: string; onSave: (v: string) => void; strong?: boolean; placeholder?: string; allowEmpty?: boolean }) {
  const [v, setV] = useState(value)
  const [prev, setPrev] = useState(value)
  if (value !== prev) {
    setPrev(value)
    setV(value)
  }
  const commit = () => {
    const t = v.trim()
    if (t === value.trim()) return
    if (!t && !allowEmpty) return setV(value)
    onSave(t)
  }
  return (
    <input
      className={'cell-input' + (strong ? ' strong' : '')}
      aria-label={label}
      value={v}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') { setV(value); e.stopPropagation(); requestAnimationFrame(() => (e.target as HTMLInputElement).blur()) }
      }}
    />
  )
}

function AddTerm({ onDone }: { onDone: (t?: Term) => void }) {
  const [term, setTerm] = useState('')
  const [translation, setTranslation] = useState('')
  const [note, setNote] = useState('')
  const ok = term.trim() && translation.trim()
  return (
    <form
      className="card terms-add"
      onSubmit={(e) => {
        e.preventDefault()
        if (ok) void api.library.addTerm({ term, translation, note }).then(onDone)
      }}
      onKeyDown={(e) => e.key === 'Escape' && onDone()}
    >
      <input className="input" placeholder="原文，例如 attention head" aria-label="原文" value={term} onChange={(e) => setTerm(e.target.value)} autoFocus spellCheck={false} />
      <input className="input" placeholder="译法，例如 注意力头" aria-label="译法" value={translation} onChange={(e) => setTranslation(e.target.value)} />
      <input className="input" placeholder="备注（可以不填）" aria-label="备注" value={note} onChange={(e) => setNote(e.target.value)} />
      <button type="button" className="btn" onClick={() => onDone()}>取消</button>
      <button type="submit" className="btn btn-p" disabled={!ok}>加入</button>
    </form>
  )
}
