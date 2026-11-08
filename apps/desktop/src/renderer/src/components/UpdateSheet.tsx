// 发现新版本时问用户：显示版本号和发布说明，"稍后"或"立即更新"。
// 点了立即更新就在这里显示下载进度，下好后应用自己重启安装；下载时可以先把这个框收起来。
import { useEffect } from 'react'
import type { UpdateState } from '../../../shared/api'
import { api } from '../lib/library'

export function UpdateSheet({ state, version, onClose }: { state: UpdateState; version: string; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && state.kind !== 'ready' && (e.stopPropagation(), onClose())
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [onClose, state.kind])

  // 发布说明第一行是 "Flax 0.1.4" 这样的标题，上面已经写了版本号
  const notes = state.kind === 'available' ? (state.notes ?? '').replace(/^Flax \S+\n?/, '').trim() : ''
  return (
    <div className="scrim">
      <div className="sheet update-sheet" role="dialog" aria-modal="true" aria-labelledby="upd-h">
        <div className="tray-h">
          <span className="lbl">软件更新</span>
          <h2 id="upd-h" className="sheet-h">
            {state.kind === 'error' ? '更新没有完成' : `Flax ${'version' in state ? state.version : ''} 可以更新了`}
          </h2>
        </div>
        {state.kind === 'available' && (
          <>
            <p className="hint" style={{ margin: '0 8px' }}>你现在用的是 {version}。</p>
            {notes && <div className="card update-notes">{notes}</div>}
            <div className="sheet-actions">
              <button type="button" className="btn" onClick={onClose}>稍后</button>
              <button type="button" className="btn btn-p" autoFocus onClick={() => void api.update.install()}>立即更新</button>
            </div>
          </>
        )}
        {state.kind === 'downloading' && (
          <>
            <div className="update-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={state.percent ?? 0} aria-label="下载进度">
              <i style={{ width: `${state.percent ?? 0}%` }} />
            </div>
            <p className="hint" style={{ margin: '0 8px' }}>正在下载{state.percent !== undefined ? `（${state.percent}%）` : '…'}，下载好后 Flax 会自动重启并完成更新。</p>
            <div className="sheet-actions">
              <button type="button" className="btn" onClick={onClose}>在后台下载</button>
            </div>
          </>
        )}
        {state.kind === 'ready' && <p className="hint" style={{ margin: '0 8px 8px' }}>下载好了，正在重启…</p>}
        {state.kind === 'error' && (
          <>
            <p className="hint" style={{ margin: '0 8px' }}>{state.message}</p>
            <div className="sheet-actions">
              <button type="button" className="btn btn-p" autoFocus onClick={onClose}>好</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
