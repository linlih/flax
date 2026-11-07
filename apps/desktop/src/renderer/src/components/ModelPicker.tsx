// 对话框里的模型选择：列出所有已连接服务的模型，按服务分组；选了就记住，下次默认用它。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AiModel, AiStatus } from '../../../shared/api'
import { serviceName, usableServices } from '../lib/ai'
import { api } from '../lib/library'
import { Icon, Spinner } from './Icon'

type Lists = Record<string, { state: 'loading' } | { state: 'ok'; models: AiModel[] } | { state: 'error'; message: string }>

/** 渲染进程这边也记一份，按钮上显示模型的好看名字 */
const known = new Map<string, AiModel[]>()

/** 模型的显示名；不知道是哪家服务时在所有已知列表里找 */
export function modelName(service: string | null, model: string): string {
  const lists = service ? [known.get(service) ?? []] : [...known.values()]
  for (const l of lists) {
    const m = l.find((x) => x.id === model)
    if (m?.name) return m.name
  }
  return model
}

export function ModelPicker({ status, onManage, up = true }: { status: AiStatus; onManage: () => void; up?: boolean }) {
  const [open, setOpen] = useState(false)
  const [lists, setLists] = useState<Lists>({})
  const [q, setQ] = useState('')
  const [, bump] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const services = usableServices(status)
  const sel = status.selection

  const load = (id: string, refresh = false) => {
    setLists((l) => ({ ...l, [id]: { state: 'loading' } }))
    void api.ai.models(id, refresh).then((r) => {
      if (r.ok) known.set(id, r.models)
      setLists((l) => ({ ...l, [id]: r.ok ? { state: 'ok', models: r.models } : { state: 'error', message: r.message } }))
    })
  }

  // 按钮上的名字：取一下当前服务的模型列表（主进程有缓存）
  useEffect(() => {
    if (sel && !known.has(sel.service)) void api.ai.models(sel.service).then((r) => r.ok && (known.set(sel.service, r.models), bump((n) => n + 1)))
  }, [sel])

  useEffect(() => {
    if (!open) return
    services.forEach((s) => load(s.id))
    requestAnimationFrame(() => search.current?.focus())
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), setOpen(false))
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', esc, true)
    return () => {
      window.removeEventListener('pointerdown', away)
      window.removeEventListener('keydown', esc, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const total = useMemo(() => Object.values(lists).reduce((n, l) => n + (l.state === 'ok' ? l.models.length : 0), 0), [lists])
  const query = q.trim().toLowerCase()
  const pick = (service: string, model: string) => {
    void api.ai.select({ service, model })
    setOpen(false)
    setQ('')
  }

  return (
    <div className="mp" ref={root}>
      <button type="button" className="mp-btn" aria-haspopup="listbox" aria-expanded={open} title={sel ? `${serviceName(status.services.find((s) => s.id === sel.service)!)} · ${sel.model}` : '选择模型'} onClick={() => setOpen((o) => !o)}>
        <span className="mp-cur">{sel ? modelName(sel.service, sel.model) : '选择模型'}</span>
        <Icon name="down" size={12} />
      </button>
      {open && (
        <div className={`mp-menu ${up ? 'up' : 'down'}`} role="listbox" aria-label="模型">
          {total > 8 && (
            <div className="mp-search">
              <Icon name="search" size={14} />
              <input ref={search} type="text" placeholder="搜索模型" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
            </div>
          )}
          <div className="mp-scroll">
            {services.length === 0 && <p className="hint mp-empty">还没有能用的服务。</p>}
            {services.map((s) => {
              const l = lists[s.id]
              const models = l?.state === 'ok' ? l.models.filter((m) => !query || m.id.toLowerCase().includes(query) || m.name?.toLowerCase().includes(query)) : []
              if (query && l?.state === 'ok' && models.length === 0) return null
              return (
                <div key={s.id} className="mp-group">
                  <div className="mp-h">
                    <span>{serviceName(s)}</span>
                    {l?.state === 'loading' && <Spinner />}
                  </div>
                  {l?.state === 'error' && (
                    <p className="mp-err ai-error">{l.message}<button type="button" className="link" onClick={() => load(s.id, true)}>重试</button></p>
                  )}
                  {models.map((m) => {
                    const on = sel?.service === s.id && sel.model === m.id
                    return (
                      <button key={m.id} type="button" role="option" aria-selected={on} className="mp-item" title={m.id} onClick={() => pick(s.id, m.id)}>
                        <span className="mp-name">{m.name ?? m.id}</span>
                        {on && <Icon name="done" size={14} />}
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>
          <div className="mp-foot">
            <button type="button" className="link" onClick={() => services.forEach((s) => load(s.id, true))}>刷新列表</button>
            <button type="button" className="link" onClick={() => { setOpen(false); onManage() }}>管理 AI 服务</button>
          </div>
        </div>
      )}
    </div>
  )
}
