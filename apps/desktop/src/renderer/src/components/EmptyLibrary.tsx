import { useState, type DragEvent } from 'react'
import { Icon } from './Icon'

interface Props {
  onFiles: (files: File[]) => void
  onPick: () => void
  onZotero: () => void
  onOpenSettings: () => void
}

/** 空文献库：整块就是拖放区。不弹设置向导（见 DESIGN.md「MVP 必需界面」）。 */
export function EmptyLibrary({ onFiles, onPick, onZotero, onOpenSettings }: Props) {
  const [over, setOver] = useState(false)
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    // 窗口本身也接受拖放，这里处理过就不再往上传
    e.stopPropagation()
    setOver(false)
    const pdfs = [...e.dataTransfer.files].filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'))
    if (pdfs.length) onFiles(pdfs)
  }
  return (
    <>
      <section className="tray" aria-label="添加第一篇论文">
        <div
          className={'card drop' + (over ? ' over' : '')}
          onDragOver={(e) => { e.preventDefault(); setOver(true) }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <span className="icon-badge"><Icon name="upload" size={28} /></span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <h2>把 PDF 拖到这里，就能开始读</h2>
            <p>标题、作者、年份会自动识别。也可以粘贴 DOI 或 arXiv 链接。</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-p" onClick={onPick}>选择 PDF</button>
            <button type="button" className="btn" onClick={onZotero} title="在 Zotero 里：文件 › 导出文献库…，格式选 BibTeX，勾选「导出文件」">从 Zotero 迁移</button>
          </div>
        </div>
      </section>
      <div className="grid2">
        <section className="tray" aria-labelledby="h-ai">
          <div className="tray-h">
            <h2 id="h-ai" className="lbl" style={{ margin: 0 }}>AI</h2>
            <span style={{ fontWeight: 500 }}>可选 · 不设置也能阅读、高亮和写笔记</span>
          </div>
          <div className="card">
            <button type="button" className="row row-btn" onClick={onOpenSettings}><span className="rt"><b>用自己的 API Key</b><small>Anthropic、OpenAI、DeepSeek 等，按用量直接付给服务商</small></span><Icon name="chevron" size={14} /></button>
            <button type="button" className="row row-btn" onClick={onOpenSettings}><span className="rt"><b>用本机模型</b><small>通过 Ollama 在这台电脑上运行，不用联网</small></span><Icon name="chevron" size={14} /></button>
          </div>
        </section>
        <section className="tray" aria-labelledby="h-data">
          <div className="tray-h"><h2 id="h-data" className="lbl" style={{ margin: 0 }}>你的数据</h2></div>
          <div className="card">
            <div className="row"><span className="rt"><b>文件在你的电脑上</b><small>普通 PDF 和 Markdown，随时可以带走</small></span></div>
            <div className="row"><span className="rt"><b>开源</b><small>AGPL-3.0，代码公开</small></span></div>
          </div>
        </section>
      </div>
    </>
  )
}
