// 模型回答的显示：简单的 Markdown（段落、列表、粗体、斜体、行内代码）+ 原文定位。
// ⟦页码|原文⟧ 显示成小号的编号，悬停看原文，点击跳到论文里那一句。
import { Fragment, type ReactNode } from 'react'
import { splitCitations } from '@flax/core'

interface Props {
  text: string
  /** 还在生成：最后加一个闪烁的光标 */
  streaming?: boolean
  onCite?: (page: number, quote: string) => void
}

export function AiText({ text, streaming, onCite }: Props) {
  // 编号在整段回答里统一，同一句原文只编一个号
  const numbers = new Map<string, number>()
  for (const s of splitCitations(text)) if (s.kind === 'cite') numbers.set(`${s.page}|${s.quote}`, s.n)

  const blocks = toBlocks(stripOpenMarker(text))
  return (
    <div className="ai-text">
      {blocks.map((b, i) => {
        const last = i === blocks.length - 1
        const tail = streaming && last ? <span className="ai-caret" aria-hidden="true" /> : null
        if (b.kind === 'list') {
          const Tag = b.ordered ? 'ol' : 'ul'
          return (
            <Tag key={i}>
              {b.items.map((it, j) => <li key={j}>{inline(it, numbers, onCite)}{last && j === b.items.length - 1 ? tail : null}</li>)}
            </Tag>
          )
        }
        return <p key={i} className={b.kind === 'heading' ? 'ai-h' : undefined}>{inline(b.text, numbers, onCite)}{tail}</p>
      })}
      {streaming && blocks.length === 0 && <p><span className="ai-caret" aria-hidden="true" /></p>}
    </div>
  )
}

function stripOpenMarker(text: string): string {
  const open = text.lastIndexOf('⟦')
  return open >= 0 && text.indexOf('⟧', open) < 0 ? text.slice(0, open) : text
}

type Block = { kind: 'p' | 'heading'; text: string } | { kind: 'list'; ordered: boolean; items: string[] }

function toBlocks(text: string): Block[] {
  const out: Block[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push({ kind: 'p', text: para.join(' ') })
    para = []
  }
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    const li = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line)
    const h = /^#{1,6}\s+(.*)$/.exec(line)
    if (!line.trim()) flush()
    else if (h) {
      flush()
      out.push({ kind: 'heading', text: h[1]! })
    } else if (li) {
      flush()
      const ordered = !li[1]
      const prev = out[out.length - 1]
      if (prev?.kind === 'list' && prev.ordered === ordered) prev.items.push(li[3]!)
      else out.push({ kind: 'list', ordered, items: [li[3]!] })
    } else {
      const prev = out[out.length - 1]
      // 列表项的续行
      if (!para.length && prev?.kind === 'list' && /^\s+/.test(raw)) prev.items[prev.items.length - 1] += ' ' + line.trim()
      else para.push(line.trim())
    }
  }
  flush()
  return out
}

function inline(text: string, numbers: Map<string, number>, onCite?: (page: number, quote: string) => void): ReactNode[] {
  const out: ReactNode[] = []
  const re = /⟦\s*(\d+)\s*\|([^⟧]*)⟧|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\s][^*]*)\*/g
  let last = 0
  let k = 0
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0
    if (i > last) out.push(<Fragment key={k++}>{text.slice(last, i)}</Fragment>)
    if (m[1]) {
      const page = Number(m[1])
      const quote = (m[2] ?? '').trim()
      const n = numbers.get(`${page}|${quote}`) ?? 0
      out.push(
        <button key={k++} type="button" className="ai-cite" title={`第 ${page} 页：${quote}`} aria-label={`原文 ${n}，第 ${page} 页`} onClick={() => onCite?.(page, quote)}>
          {n}
        </button>
      )
    } else if (m[3]) out.push(<strong key={k++}>{m[3]}</strong>)
    else if (m[4]) out.push(<code key={k++}>{m[4]}</code>)
    else if (m[5]) out.push(<em key={k++}>{m[5]}</em>)
    last = i + m[0].length
  }
  if (last < text.length) out.push(<Fragment key={k++}>{text.slice(last)}</Fragment>)
  return out
}
