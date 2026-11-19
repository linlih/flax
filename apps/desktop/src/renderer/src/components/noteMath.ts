// 公式：$行内$ 和 $$独立成段$$（Pandoc、Obsidian、Typora 都认的写法），用 KaTeX 就地排出来。
// 这里只管找公式和画公式；什么时候显示源码、什么时候显示排好的样子在 livePreview / noteBlocks 里。
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { WidgetType, type EditorView } from '@codemirror/view'

export interface InlineMath {
  /** 在这一行里的位置（含两边的 $） */
  from: number
  to: number
  tex: string
}

const SPACE = /\s/
/**
 * 一行里的 $行内公式$。规则和 Pandoc 一样，免得把钱数当公式：
 * 开头的 $ 后面不能是空格，结尾的 $ 前面不能是空格、后面不能紧跟数字；\$ 是普通的 $。
 */
export function findInlineMath(s: string): InlineMath[] {
  const out: InlineMath[] = []
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue }
    if (s[i] !== '$') continue
    // $$ 是独立公式，这里不管
    if (s[i + 1] === '$') { i++; continue }
    if (i + 1 >= s.length || SPACE.test(s[i + 1]!)) continue
    let j = i + 1
    for (; j < s.length; j++) {
      if (s[j] === '\\') { j++; continue }
      if (s[j] !== '$') continue
      if (SPACE.test(s[j - 1]!) || /\d/.test(s[j + 1] ?? '')) { j = -1; break }
      break
    }
    if (j < 0 || j >= s.length || s[j + 1] === '$') continue
    out.push({ from: i, to: j + 1, tex: s.slice(i + 1, j) })
    i = j
  }
  return out
}

export interface MathBlock {
  /** 第几行到第几行（从 0 数，含两头） */
  first: number
  last: number
  tex: string
}

/** 独立成段的 $$公式$$：可以一行写完，也可以 $$ 单独占一行、中间写多行 */
export function findMathBlocks(lines: string[]): MathBlock[] {
  const out: MathBlock[] = []
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim()
    if (!t.startsWith('$$')) continue
    const rest = t.slice(2)
    if (rest.length >= 2 && rest.endsWith('$$') && !rest.endsWith('\\$$')) {
      if (rest.slice(0, -2).trim()) out.push({ first: i, last: i, tex: rest.slice(0, -2).trim() })
      continue
    }
    if (rest.includes('$$')) continue
    const body = [rest]
    let j = i + 1
    for (; j < lines.length; j++) {
      const u = lines[j]!.trim()
      // 空行把段落断开了：没写完的公式不算
      if (!u) { j = lines.length; break }
      if (u.endsWith('$$')) { body.push(u.slice(0, -2)); break }
      body.push(lines[j]!)
    }
    if (j >= lines.length) continue
    out.push({ first: i, last: j, tex: body.join('\n').trim() })
    i = j
  }
  return out
}

const cache = new Map<string, string>()
/** KaTeX 排好的 HTML；写错了不报错，显示红色的原文 */
export function renderTex(tex: string, display: boolean): string {
  const key = (display ? 'D' : 'I') + tex
  let html = cache.get(key)
  if (html == null) {
    html = katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'html', strict: 'ignore', trust: false })
    if (cache.size > 500) cache.clear()
    cache.set(key, html)
  }
  return html
}

/** 排好的公式。点一下把光标放进源码里（Typora 的做法） */
export class MathWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean, readonly preview = false) { super() }
  eq(o: MathWidget) { return o.tex === this.tex && o.display === this.display && o.preview === this.preview }
  toDOM(view: EditorView) {
    const el: HTMLElement = document.createElement(this.display ? 'div' : 'span')
    el.className = this.preview ? 'cm-lp-math-preview' : this.display ? 'cm-lp-math-block' : 'cm-lp-math'
    if (!this.tex.trim()) {
      el.textContent = this.preview ? '' : '公式'
      el.classList.add('cm-lp-math-empty')
    } else el.innerHTML = renderTex(this.tex, this.display)
    if (!this.preview) {
      el.title = '点击修改公式'
      el.addEventListener('mousedown', (e: MouseEvent) => {
        if (e.button !== 0) return
        e.preventDefault()
        const at = view.posAtDOM(el)
        // 行内公式：光标放在 $ 后面；独立公式：放到第一行 $$ 后面
        view.dispatch({ selection: { anchor: at + (this.display ? 2 : 1) }, scrollIntoView: true })
        view.focus()
      })
    }
    return el
  }
  ignoreEvent() { return true }
}
