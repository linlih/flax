// 废纸篓：删掉的论文先到这里，可以放回文献库，也可以永久删除。
// 永久删除前由主进程问一次（系统的确认框），PDF 移到系统的废纸篓。
import type { TrashedPaper } from '@flax/core'
import { addedLabel, authorLine } from '../lib/format'
import { api } from '../lib/library'

export function TrashView({ papers, onToast }: { papers: TrashedPaper[]; onToast: (text: string) => void }) {
  const restore = (p: TrashedPaper) => {
    void api.library.restore(p.id)
    onToast(`已放回文献库：${p.title}`)
  }
  return (
    <section className="tray" aria-labelledby="h-trash">
      <div className="tray-h tray-h-row">
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <h2 id="h-trash" className="lbl" style={{ margin: 0 }}>删掉的论文</h2>
          <span className="big num">{papers.length} 篇</span>
        </div>
        {papers.length > 0 && <button type="button" className="btn btn-s danger-text" onClick={() => void api.library.purge([])}>全部永久删除…</button>}
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <div role="table" aria-label="废纸篓里的论文" aria-rowcount={papers.length}>
          <div role="row" className="tr th tr-trash">
            <span role="columnheader">论文</span>
            <span role="columnheader" className="r">删除时间</span>
            <span role="columnheader" className="sr">操作</span>
          </div>
          <div role="rowgroup">
            {papers.map((p) => (
              <div key={p.id} role="row" className="tr td tr-trash">
                <div role="cell" className="cell-paper">
                  <span className="rt">
                    <b className="row-title" title={p.title}>{p.title}</b>
                    {(authorLine(p) || p.year) && <small>{[authorLine(p), p.year].filter(Boolean).join(' · ')}</small>}
                  </span>
                </div>
                <div role="cell" className="r cell-muted num">{addedLabel(p.deletedAt)}</div>
                <div role="cell" className="trash-acts">
                  <button type="button" className="btn btn-s" onClick={() => restore(p)}>放回</button>
                  <button type="button" className="btn btn-s danger-text" onClick={() => void api.library.purge([p.id])}>永久删除…</button>
                </div>
              </div>
            ))}
            {papers.length === 0 && <div className="table-empty">废纸篓是空的。</div>}
          </div>
        </div>
      </div>
    </section>
  )
}
