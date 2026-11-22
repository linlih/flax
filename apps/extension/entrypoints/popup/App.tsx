// 点了工具栏上的图标：马上开始存，小窗里只显示进度和结果（docs/12-浏览器插件.md 第 5.2、5.3 节）。
import { useCallback, useEffect, useRef, useState } from 'react'
import { looksLikePaper, type PageInfo } from '../../utils/extract'
import { flax, FlaxError, type Saved } from '../../utils/flax'
import { markSaved, readTab } from '../../utils/tab'

type State =
  | { kind: 'reading' }
  | { kind: 'no_paper' }
  | { kind: 'offline'; waking: boolean }
  | { kind: 'saving'; pdf: boolean }
  | { kind: 'saved'; r: Saved }
  | { kind: 'error'; message: string }

export function App() {
  const [state, setState] = useState<State>({ kind: 'reading' })
  const [page, setPage] = useState<PageInfo | null>(null)
  const tabId = useRef<number | null>(null)
  const alive = useRef(true)
  useEffect(() => () => void (alive.current = false), [])

  const save = useCallback(async (p: PageInfo) => {
    setState({ kind: 'saving', pdf: p.isPdf })
    try {
      const r = await flax.save(p)
      if (!alive.current) return
      setState({ kind: 'saved', r })
      if (tabId.current !== null) void markSaved(tabId.current, true)
    } catch (e) {
      if (!alive.current) return
      if (e instanceof FlaxError && e.kind === 'offline') return setState({ kind: 'offline', waking: false })
      if (e instanceof FlaxError && e.kind === 'no_paper') return setState({ kind: 'no_paper' })
      if (e instanceof FlaxError && e.kind === 'too_old') return setState({ kind: 'error', message: '这个插件版本太旧了，请更新插件。' })
      setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }, [])

  useEffect(() => {
    void (async () => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id || !tab.url) return setState({ kind: 'no_paper' })
      tabId.current = tab.id
      const p = await readTab(tab.id, tab.url)
      if (!alive.current) return
      setPage(p)
      if (!looksLikePaper(p)) return setState({ kind: 'no_paper' })
      await save(p)
    })()
  }, [save])

  /** Flax 没开：用 flax://open 唤起它，然后每秒问一次，连上就接着存 */
  const wake = async () => {
    setState({ kind: 'offline', waking: true })
    try {
      if (tabId.current !== null) await browser.tabs.update(tabId.current, { url: 'flax://open' })
    } catch {
      window.open('flax://open')
    }
    for (let i = 0; i < 15 && alive.current; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      if (await flax.ping().then(() => true, () => false)) return page && save(page)
    }
    if (alive.current) setState({ kind: 'offline', waking: false })
  }

  const title = state.kind === 'saved' ? state.r.title : page?.meta.title
  return (
    <main>
      <header>
        <img src="/icon/32.png" alt="" width={16} height={16} />
        <span>Flax</span>
      </header>
      <div className="card">
        {title && <p className="title">{title}</p>}
        {page?.meta.authors?.length && state.kind !== 'saved' ? <p className="sub">{authorLine(page.meta.authors)}{page.meta.year ? ` · ${page.meta.year}` : ''}</p> : null}
        <Status state={state} />
      </div>
      <Actions state={state} onWake={() => void wake()} onRetry={() => page && void save(page)} />
    </main>
  )
}

function Status({ state }: { state: State }) {
  switch (state.kind) {
    case 'reading':
      return <p className="status"><span className="spin" />正在读页面…</p>
    case 'saving':
      return <p className="status"><span className="spin" />{state.pdf ? 'Flax 正在下载这个 PDF…' : '正在存进文献库…'}</p>
    case 'saved':
      return (
        <p className="status ok">
          {state.r.status === 'added' ? '已存进文献库' : '已在文献库'}
          {!state.r.hasPdf && <span className="sub">　还没有 PDF</span>}
        </p>
      )
    case 'no_paper':
      return <p className="status">这个页面上没找到论文。</p>
    case 'offline':
      return <p className="status">{state.waking ? <><span className="spin" />正在打开 Flax…</> : 'Flax 没有打开。'}</p>
    case 'error':
      return <p className="status err">没存成：{state.message}</p>
  }
}

function Actions({ state, onWake, onRetry }: { state: State; onWake: () => void; onRetry: () => void }) {
  if (state.kind === 'saved') {
    return (
      <div className="actions">
        <button type="button" className="primary" onClick={() => void flax.open(state.r.paperId).then(() => window.close(), () => {})}>在 Flax 中打开</button>
      </div>
    )
  }
  if (state.kind === 'offline' && !state.waking) {
    return (
      <div className="actions">
        <button type="button" className="primary" onClick={onWake}>打开 Flax</button>
        <button type="button" onClick={onRetry}>重试</button>
      </div>
    )
  }
  if (state.kind === 'error') {
    return (
      <div className="actions">
        <button type="button" onClick={onRetry}>重试</button>
      </div>
    )
  }
  return null
}

function authorLine(names: string[]): string {
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} 等` : names.join(', ')
}
