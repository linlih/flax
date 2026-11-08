import { useEffect, useRef } from 'react'
import type { ImportNotice } from '../../../shared/api'
import { Icon } from './Icon'
import { api } from '../lib/library'

export interface Toast {
  key: number
  text: string
  action?: { label: string; run: () => void }
  /** 同一组的新提示顶掉旧的（比如连着改几次阅读状态，只留最后一条） */
  group?: string
}

type Keyed = ImportNotice & { key: number }

/** 底部的轻提示，几秒后自动消失；重复导入时弹出需要选择的对话框 */
export function Notices({ notices, toasts, dismiss, dismissToast, onShowPaper }: {
  notices: Keyed[]
  toasts: Toast[]
  dismiss: (key: number) => void
  dismissToast: (key: number) => void
  onShowPaper: (id: string) => void
}) {
  const ask = notices.find((n) => n.kind === 'same_paper') as Extract<Keyed, { kind: 'same_paper' }> | undefined
  const light = notices.filter((n) => n.kind !== 'same_paper')

  return (
    <>
      <div className="toasts" aria-live="polite">
        {light.map((n) => <NoticeToast key={n.key} n={n} onClose={() => dismiss(n.key)} onShowPaper={onShowPaper} />)}
        {toasts.map((t) => <ToastView key={t.key} toast={t} onClose={() => dismissToast(t.key)} />)}
      </div>
      {ask && <DuplicateSheet n={ask} onClose={() => dismiss(ask.key)} />}
    </>
  )
}

function NoticeToast({ n, onClose, onShowPaper }: { n: Keyed; onClose: () => void; onShowPaper: (id: string) => void }) {
  if (n.kind === 'same_file') {
    return <ToastView toast={{ key: n.key, text: `这篇已经在库里了：${n.title}`, action: { label: '查看', run: () => onShowPaper(n.paperId) } }} onClose={onClose} />
  }
  if (n.kind === 'not_pdf') return <ToastView toast={{ key: n.key, text: `${n.fileName} 不是有效的 PDF，没有导入` }} onClose={onClose} />
  if (n.kind === 'attached') {
    return <ToastView toast={{ key: n.key, text: `PDF 已配给库里的论文：${n.title}`, action: { label: '查看', run: () => onShowPaper(n.paperId) } }} onClose={onClose} />
  }
  if (n.kind === 'download_failed') {
    return <ToastView toast={{ key: n.key, text: `没能从 arXiv 下载 PDF（${n.message}）：${n.title}`, action: { label: '重试', run: () => void api.library.downloadPdf(n.paperId) } }} onClose={onClose} />
  }
  if (n.kind === 'bib_done') {
    if (!n.added && !n.existing) return <ToastView toast={{ key: n.key, text: '这个文件里没有找到文献。请确认是从 Zotero 导出的 BibTeX（.bib）文件。' }} onClose={onClose} />
    const parts = [`新加 ${n.added} 篇`, n.existing ? `${n.existing} 篇库里已有` : '', n.missingFiles ? `${n.missingFiles} 个 PDF 没找到` : ''].filter(Boolean)
    return <ToastView toast={{ key: n.key, text: `导入完成：${parts.join('，')}` }} onClose={onClose} />
  }
  if (n.kind === 'failed') return <ToastView toast={{ key: n.key, text: `${n.fileName} 导入失败：${n.message}` }} onClose={onClose} />
  return null
}

function ToastView({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  // 父组件每次渲染都会给新的 onClose，用 ref 拿最新的，避免计时器被反复重置
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const t = setTimeout(() => close.current(), toast.action ? 8000 : 5000)
    return () => clearTimeout(t)
  }, [toast.key, Boolean(toast.action)])
  return (
    <div className="toast" role="status">
      <span className="toast-t">{toast.text}</span>
      {toast.action && <button type="button" className="toast-a" onClick={() => { toast.action!.run(); onClose() }}>{toast.action.label}</button>}
      <button type="button" className="toast-x" aria-label="关闭提示" onClick={onClose}><Icon name="close" size={14} /></button>
    </div>
  )
}

function DuplicateSheet({ n, onClose }: { n: Extract<Keyed, { kind: 'same_paper' }>; onClose: () => void }) {
  const choose = (action: 'add_version' | 'skip') => {
    void api.library.resolveDuplicate(n.token, action)
    onClose()
  }
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && choose('skip')
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })
  const e = n.existing
  return (
    <div className="scrim">
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="dup-h">
        <div className="tray-h">
          <span className="lbl">重复导入</span>
          <h2 id="dup-h" className="sheet-h">这篇已经在库里了</h2>
        </div>
        <div className="card">
          <div className="row"><span className="rt"><small>库里的</small><b>{e.title}</b><small>{[e.venue, e.year, `${e.files} 个文件`].filter(Boolean).join(' · ')}</small></span></div>
          <div className="row"><span className="rt"><small>新拖入的</small><b>{n.fileName}</b><small>内容和库里的文件不同</small></span></div>
        </div>
        <p className="hint" style={{ margin: '0 8px' }}>建议作为同一篇论文的另一个文件保存，批注互不影响。</p>
        <div className="sheet-actions">
          <button type="button" className="btn" onClick={() => choose('skip')}>不导入</button>
          <button type="button" className="btn btn-p" autoFocus onClick={() => choose('add_version')}>加为另一个版本</button>
        </div>
      </div>
    </div>
  )
}
