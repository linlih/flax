// 对话框里的思考深度：和模型一样在对话里选，选了就记住。翻译不受影响（固定用最快的）。
// 只列当前模型支持的几档；模型不能调时按钮变灰并说明。换到不支持所选那档的模型时，用最近的浅一档。
import { useEffect, useRef, useState } from 'react'
import type { AiEffort, AiModel, AiStatus } from '../../../shared/api'
import { vendorOf } from '../../../shared/aiVendors'
import { levelsFor, resolveEffort } from '../../../shared/effort'
import { api } from '../lib/library'
import { Icon } from './Icon'

const LABEL: Record<AiEffort, string> = { auto: '自动', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' }
const HINT: Record<AiEffort, string> = {
  auto: '用模型自己的默认',
  low: '最快，适合查词和简单问题',
  medium: '一般的问题',
  high: '想得更久，适合推导和比较',
  xhigh: '比"高"更久，适合难的推导',
  max: '最慢，也最费 token'
}

export function EffortPicker({ status, up = true }: { status: AiStatus; up?: boolean }) {
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<{ service: string; list: AiModel[] } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const sel = status.selection
  const service = sel ? status.services.find((s) => s.id === sel.service) : undefined
  const kind = vendorOf(service?.vendor ?? '')?.kind ?? 'openai'

  // 当前模型支持哪几档：主进程缓存了模型列表，这里要一次
  useEffect(() => {
    if (!sel) return
    let alive = true
    void api.ai.models(sel.service).then((r) => alive && r.ok && setModels({ service: sel.service, list: r.models }))
    return () => {
      alive = false
    }
  }, [sel?.service])

  const model = models && sel && models.service === sel.service ? models.list.find((m) => m.id === sel.model) : undefined
  const levels = levelsFor(kind, model)
  const cur = status.effort
  const used = resolveEffort(cur, levels) ?? 'auto'
  const fixed = levels.length === 0

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

  if (!sel) return null
  const title = fixed
    ? '这个模型不能调思考深度'
    : used !== cur
      ? `思考深度：${LABEL[used]}（这个模型没有"${LABEL[cur]}"，用最接近的一档）`
      : `思考深度：${LABEL[cur]}`

  return (
    <div className="mp" ref={root}>
      <button type="button" className="mp-btn" aria-haspopup="listbox" aria-expanded={open} disabled={fixed} title={title} onClick={() => setOpen((o) => !o)}>
        <span className="mp-cur">{fixed ? '思考 不可调' : `思考 ${LABEL[used]}`}</span>
        {!fixed && <Icon name="down" size={12} />}
      </button>
      {open && !fixed && (
        <div className={`mp-menu ep-menu ${up ? 'up' : 'down'}`} role="listbox" aria-label="思考深度">
          <div className="mp-scroll">
            {(['auto', ...levels] as AiEffort[]).map((e) => (
              <button
                key={e}
                type="button"
                role="option"
                aria-selected={e === used}
                className="mp-item"
                onClick={() => {
                  void api.ai.setEffort(e)
                  setOpen(false)
                }}
              >
                <span className="ep-name">{LABEL[e]}</span>
                <span className="ep-hint">{HINT[e]}</span>
                {e === used && <Icon name="done" size={14} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
