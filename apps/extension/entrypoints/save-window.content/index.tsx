// 网页右上角的保存窗口（docs/12-浏览器插件.md 第 10 节，照 Zotero 的保存窗口）。
// 点工具栏图标时由后台注入；只负责显示后台的保存进度，以及改文件夹、加标签。
// 存完 3 秒自己收起，鼠标停在上面或者正在输入时不收。
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import css from './style.css?inline'
import type { Folder } from '../../utils/flax'
import { busy, type SaveState, type ToBackground, type ToWindow } from '../../utils/session'

export default defineContentScript({
  // 不常驻：只在用户点了图标时注入到那一个页面
  registration: 'runtime',
  matches: ['<all_urls>'],
  cssInjectionMode: 'manual',
  main() {
    const w = window as unknown as { __flaxSaveWindow?: boolean }
    if (w.__flaxSaveWindow) return
    w.__flaxSaveWindow = true
    const host = document.createElement('flax-save-window')
    // 放进浏览器的顶层（popover），网页自己的遮罩、z-index 再高也盖不住它
    host.setAttribute('popover', 'manual')
    host.style.cssText = 'position:fixed;inset:0 0 auto auto;margin:0;padding:0;border:0;background:transparent;overflow:visible;width:auto;height:auto;color-scheme:normal'
    const root = host.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = css
    root.append(style)
    const mount = document.createElement('div')
    root.append(mount)
    document.documentElement.append(host)
    try {
      host.showPopover()
    } catch {
      // 老浏览器没有 popover：还是 position: fixed + 最大的 z-index
    }
    createRoot(mount).render(<SaveWindow onShow={() => host.isConnected && !host.matches(':popover-open') && host.showPopover?.()} />)
  }
})

const send = <T,>(msg: ToBackground) => browser.runtime.sendMessage(msg) as Promise<T>

function SaveWindow({ onShow }: { onShow: () => void }) {
  const [state, setState] = useState<SaveState | null>(null)
  const [visible, setVisible] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [targets, setTargets] = useState<{ folders: Folder[]; tags: string[] } | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const hovering = useRef(false)
  const timer = useRef<number | undefined>(undefined)

  const hide = useCallback(() => {
    window.clearTimeout(timer.current)
    setLeaving(true)
    window.setTimeout(() => {
      setVisible(false)
      setLeaving(false)
    }, 180)
  }, [])

  /** 什么时候自己收起：存完 3 秒；没找到论文 4 秒；出错 8 秒；Flax 没开、还在做事时不收 */
  const delayFor = (s: SaveState | null): number | null => {
    if (!s || busy(s)) return null
    if (s.phase === 'saved') return 3000
    if (s.phase === 'no_paper') return 4000
    if (s.phase === 'error') return 8000
    return null
  }
  const schedule = useCallback(
    (s: SaveState | null, after?: number) => {
      window.clearTimeout(timer.current)
      const d = delayFor(s)
      if (d === null || hovering.current) return
      timer.current = window.setTimeout(hide, after ?? d)
    },
    [hide]
  )

  useEffect(() => {
    const onMsg = (raw: unknown) => {
      const msg = raw as ToWindow
      if (msg?.type === 'flax:show') {
        onShow()
        setLeaving(false)
        setVisible(true)
      } else if (msg?.type === 'flax:state') {
        setState((prev) => {
          // 新的一次保存：清掉上一次的标签
          if (msg.state.phase === 'reading' || (prev?.phase === 'saved' && msg.state.phase === 'saved' && prev.paperId !== msg.state.paperId)) {
            setTags([])
            setDraft('')
          }
          return msg.state
        })
        onShow()
        setVisible(true)
      }
    }
    browser.runtime.onMessage.addListener(onMsg)
    void send<SaveState | null>({ type: 'flax:hello' }).then((s) => s && setState(s)).catch(() => {})
    return () => browser.runtime.onMessage.removeListener(onMsg)
  }, [])

  useEffect(() => schedule(state), [state, visible, schedule])

  // 存好以后拿文件夹列表和已有的标签
  const saved = state?.phase === 'saved' ? state : null
  useEffect(() => {
    if (saved && !targets) void send<{ folders: Folder[]; tags: string[] } | null>({ type: 'flax:targets' }).then((t) => t && setTargets(t)).catch(() => {})
  }, [saved, targets])

  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, hide])

  if (!visible || !state) return null

  const enter = () => {
    hovering.current = true
    window.clearTimeout(timer.current)
  }

  const addTag = (raw: string) => {
    const t = raw.trim().replace(/^#/, '').slice(0, 100)
    setDraft('')
    if (!t || tags.includes(t)) return
    setTags([...tags, t])
    void send({ type: 'flax:tags', add: [t] })
  }
  const removeTag = (t: string) => {
    setTags(tags.filter((x) => x !== t))
    void send({ type: 'flax:tags', remove: [t] })
  }

  return (
    <div
      className={`win${leaving ? ' leaving' : ''}`}
      role="dialog"
      aria-label="存进 Flax"
      onMouseEnter={enter}
      onMouseLeave={(e) => {
        hovering.current = false
        if (!(e.currentTarget.getRootNode() as ShadowRoot).activeElement) schedule(state, 2500)
      }}
      onFocus={enter}
      onBlur={(e) => {
        // 焦点离开窗口、鼠标也不在上面，才重新开始倒计时
        const el = e.currentTarget
        const root = el.getRootNode() as ShadowRoot
        window.setTimeout(() => {
          if (!root.activeElement && !el.matches(':hover')) {
            hovering.current = false
            schedule(state, 2500)
          }
        }, 0)
      }}
    >
      <div className="head">
        <span className="brand">Flax</span>
        {saved && targets ? (
          <label className="target">
            存到
            <select
              value={saved.folder ?? ''}
              onChange={(e) => {
                const folder = e.target.value || null
                setState({ ...saved, folder })
                void send({ type: 'flax:folder', folder })
              }}
            >
              <option value="">{saved.status === 'existing' ? '不改文件夹' : '文献库（不放进文件夹）'}</option>
              {targets.folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {'　'.repeat(f.depth) + f.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="target" />
        )}
        <button type="button" className="close" aria-label="关闭" onClick={hide}>
          ×
        </button>
      </div>
      <div className="body" aria-live="polite">
        <Body state={state} />
        {saved && targets && (
          <div className="tags" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
            {tags.map((t) => (
              <span className="chip" key={t}>
                {t}
                <button type="button" aria-label={`去掉标签 ${t}`} onClick={() => removeTag(t)}>
                  ×
                </button>
              </span>
            ))}
            <input
              value={draft}
              list="flax-tags"
              placeholder={tags.length ? '' : '加标签，回车确定'}
              aria-label="标签"
              onChange={(e) => {
                const v = e.target.value
                if (/[,，]/.test(v)) v.split(/[,，]/).slice(0, -1).forEach(addTag), setDraft(v.split(/[,，]/).at(-1) ?? '')
                else setDraft(v)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  addTag(draft)
                } else if (e.key === 'Backspace' && !draft && tags.length) removeTag(tags.at(-1)!)
              }}
            />
            <datalist id="flax-tags">
              {targets.tags.filter((t) => !tags.includes(t)).slice(0, 200).map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </div>
        )}
        <Actions state={state} />
      </div>
    </div>
  )
}

function Body({ state }: { state: SaveState }) {
  switch (state.phase) {
    case 'reading':
      return <p className="row"><span className="spin" />正在读页面…</p>
    case 'saving':
      return (
        <>
          {state.title && <p className="title">{state.title}</p>}
          <p className="row"><span className="spin" />{state.pdfTab ? '正在把这个 PDF 存进 Flax…' : '正在存进 Flax…'}</p>
        </>
      )
    case 'saved':
      return (
        <>
          <p className="title">{state.title}</p>
          <p className="row ok"><span className="mark">✓</span>{state.status === 'added' ? '已存进文献库' : '已在文献库'}</p>
          <p className="row top">
            <span className="label">PDF</span>
            {state.pdf.kind === 'done' ? (
              <span className="ok">已存好</span>
            ) : state.pdf.kind === 'page' ? (
              <><span className="spin" />正在从网页下载…</>
            ) : state.pdf.kind === 'flax' ? (
              <><span className="spin" />Flax 正在找免费的版本…</>
            ) : state.pdf.kind === 'missing' ? (
              <span className="muted">{state.pdf.reason ? `没下到：${state.pdf.reason}。` : '没找到可以下载的 PDF。'}以后可以拖进 Flax。</span>
            ) : (
              <span className="muted">还没有</span>
            )}
          </p>
        </>
      )
    case 'no_paper':
      return <p className="row muted">这个页面上没找到论文。</p>
    case 'offline':
      return state.waking ? <p className="row"><span className="spin" />正在打开 Flax…</p> : <p className="row">Flax 没有打开。打开它以后再存一次。</p>
    case 'error':
      return <p className="row err">没存成：{state.message}</p>
  }
}

function Actions({ state }: { state: SaveState }) {
  if (state.phase === 'saved') {
    return (
      <div className="actions">
        <button type="button" className="btn" onClick={() => void send({ type: 'flax:open' })}>在 Flax 中打开</button>
      </div>
    )
  }
  if (state.phase === 'offline' && !state.waking) {
    return (
      <div className="actions">
        <button type="button" className="btn" onClick={() => void send({ type: 'flax:retry' })}>重试</button>
        <button type="button" className="btn primary" onClick={() => void send({ type: 'flax:wake' })}>打开 Flax</button>
      </div>
    )
  }
  if (state.phase === 'error') {
    return (
      <div className="actions">
        <button type="button" className="btn" onClick={() => void send({ type: 'flax:retry' })}>重试</button>
      </div>
    )
  }
  return null
}
