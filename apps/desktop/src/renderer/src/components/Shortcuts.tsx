// 帮助 › 键盘快捷键（⌘/）：一张表列出所有快捷键，Esc 或点外面关掉。
import { useEffect } from 'react'

const GROUPS: { title: string; keys: [string, string][] }[] = [
  {
    title: '文献库',
    keys: [
      ['⌘O', '导入 PDF'],
      ['⌘V', '粘贴 DOI 或 arXiv 链接来添加'],
      ['↑ ↓', '选上一篇 / 下一篇'],
      ['↩', '开始读'],
      ['⌘⌫', '移到废纸篓'],
      ['⌘N', '新建笔记'],
      ['⌘,', '设置']
    ]
  },
  {
    title: '阅读',
    keys: [
      ['V', '选择文字'],
      ['H', '移动页面'],
      ['按住空格', '临时移动页面'],
      ['M', '高亮'],
      ['U', '下划线'],
      ['空格 / ⇧空格', '下一屏 / 上一屏'],
      ['⌘F', '在论文里查找'],
      ['⌘+ / ⌘− / ⌘0', '放大 / 缩小 / 还原'],
      ['⌘滚轮 / 捏合', '缩放'],
      ['⌃⌘F', '专注模式'],
      ['⌥⌘S', '显示或隐藏缩略图'],
      ['⌘[', '回到文献库'],
      ['Esc', '回到选择工具'],
      ['右键', '批注、摘到笔记、问 AI、翻译、复制']
    ]
  },
  {
    title: '笔记',
    keys: [
      ['[[', '链接到另一篇笔记'],
      ['/', '插入标题、列表、待办、引用'],
      ['⌘点击', '打开链接']
    ]
  }
]

export function Shortcuts({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose())
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [onClose])

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet keys-sheet" role="dialog" aria-modal="true" aria-labelledby="keys-h">
        <div className="tray-h tray-h-row">
          <h2 id="keys-h" className="sheet-h" style={{ flex: 1 }}>键盘快捷键</h2>
          <button type="button" className="btn btn-s" onClick={onClose} autoFocus>完成</button>
        </div>
        <div className="keys-grid">
          {GROUPS.map((g) => (
            <section key={g.title} className="card keys-card" aria-label={g.title}>
              <h3 className="lbl">{g.title}</h3>
              <dl>
                {g.keys.map(([k, what]) => (
                  <div key={k} className="keys-row"><dt>{what}</dt><dd><kbd>{k}</kbd></dd></div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
