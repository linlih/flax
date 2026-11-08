// 文献库标题栏的"添加论文"：一个按钮，弹出来先是粘贴 DOI / arXiv 链接的输入框，下面是选 PDF 和从 Zotero 导入。
// （⌘O 仍然直接选 PDF；在空白处 ⌘V 粘贴链接、把 PDF 拖进窗口也都能加。）
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Icon } from './Icon'
import { api } from '../lib/library'

export function AddPaper({ open, setOpen }: { open: boolean; setOpen: (v: boolean) => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setError('')
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), setOpen(false))
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key, true)
    }
  }, [open, setOpen])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    const ok = await api.library.addFromText(t).catch(() => false)
    setBusy(false)
    if (!ok) return setError('没有找到 DOI 或 arXiv 编号。其他网站的论文请下载 PDF 后选择文件添加。')
    setText('')
    setOpen(false)
  }
  const then = (f: () => unknown) => () => { setOpen(false); void f() }

  return (
    <div className="add-paper no-drag" ref={box}>
      <button type="button" className="btn btn-p" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}><Icon name="plus" size={16} />添加论文</button>
      {open && (
        <div className="add-paper-pop" role="dialog" aria-label="添加论文">
          <form onSubmit={(e) => void submit(e)}>
            <label className="field-l" htmlFor="add-paper-inp">粘贴 DOI、arXiv 编号或链接</label>
            <div className="add-paper-row">
              <input id="add-paper-inp" type="text" autoFocus placeholder="例如 https://arxiv.org/abs/1706.03762" value={text} onChange={(e) => { setText(e.target.value); setError('') }} />
              <button type="submit" className="btn btn-p" disabled={!text.trim() || busy}>{busy ? '添加中…' : '添加'}</button>
            </div>
            {error && <p className="add-paper-err" role="alert">{error}</p>}
          </form>
          <div className="add-paper-more">
            <button type="button" className="btn" onClick={then(() => api.library.pickAndImport())}><Icon name="file" size={16} />选择 PDF…</button>
            <button type="button" className="btn" onClick={then(() => api.library.importBibTeX())}>从 Zotero 或 BibTeX 导入…</button>
          </div>
        </div>
      )}
    </div>
  )
}
