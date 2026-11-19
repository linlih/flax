// 粘贴（Typora、Obsidian 的做法，再加上读论文常遇到的情况）：
//   - 从网页、Word、Google 文档复制的带格式文字 → 转成 Markdown（加粗、链接、列表、标题、表格、代码）；
//   - 从 PDF 复制的文字每行都断开、单词被连字符拆开 → 接成整段；
//   - 粘贴后按一次 ⌘Z 回到原样的纯文字，再按一次撤销粘贴。
// 代码块里粘贴不做任何处理。
import { syntaxTree } from '@codemirror/language'
import { isolateHistory } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'
import { formatTable, textWidth } from './noteTable'

// —— HTML → Markdown ——

/** 只用到 DOM 的这些，测试里可以用 linkedom */
interface DomNode {
  nodeType: number
  nodeName: string
  childNodes: ArrayLike<DomNode>
  textContent: string | null
  getAttribute?(name: string): string | null
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'META', 'TITLE', 'HEAD', 'NOSCRIPT', 'TEMPLATE', 'BUTTON', 'svg', 'SVG', 'IFRAME'])
const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'NAV', 'FIGURE', 'FIGCAPTION', 'DD', 'DT', 'DL', 'ADDRESS', 'CENTER', 'BODY', 'HTML'])

/** 文字里会被当成 Markdown 记号的字符加反斜杠 */
function escapeText(s: string): string {
  return s.replace(/([\\`*[\]])/g, '\\$1').replace(/(^|\s)_(?=\S)|(?<=\S)_(?=\s|$)/g, (m) => m.replace('_', '\\_'))
}
/** 行首会被当成块记号的 */
function escapeLineStart(s: string): string {
  return s.replace(/^(\s*)([#>+-]|\d+[.)])(?=\s)/gm, '$1\\$2')
}

const styleOf = (n: DomNode) => (n.getAttribute?.('style') ?? '').toLowerCase()
const isBoldStyle = (st: string) => /font-weight\s*:\s*(bold|[6-9]00)/.test(st)
const isItalicStyle = (st: string) => /font-style\s*:\s*italic/.test(st)
const isMonoStyle = (st: string) => /font-family\s*:[^;]*(mono|courier|consolas|menlo)/.test(st)

class Converter {
  /** 有没有转出任何格式；没有的话就当纯文字粘贴 */
  formatted = false

  block(n: DomNode, out: string[]): void {
    const name = n.nodeName.toUpperCase()
    if (n.nodeType !== 1) {
      if (n.nodeType === 3 && n.textContent?.trim()) out.push(escapeLineStart(this.inline(n)))
      return
    }
    if (SKIP.has(n.nodeName)) return
    const h = /^H([1-6])$/.exec(name)
    if (h) {
      const t = this.inlineChildren(n).trim()
      if (t) { out.push('#'.repeat(Number(h[1])) + ' ' + t); this.formatted = true }
      return
    }
    if (name === 'UL' || name === 'OL') return void out.push(this.list(n, name === 'OL'))
    if (name === 'BLOCKQUOTE') {
      const inner: string[] = []
      this.children(n, inner)
      if (inner.length) { out.push(inner.join('\n\n').replace(/^/gm, '> ')); this.formatted = true }
      return
    }
    if (name === 'PRE') {
      const code = (n.textContent ?? '').replace(/\n$/, '')
      const cls = firstChildCode(n)?.getAttribute?.('class') ?? n.getAttribute?.('class') ?? ''
      const lang = /(?:language|lang)-([\w+#-]+)/.exec(cls)?.[1] ?? ''
      out.push('```' + lang + '\n' + code + '\n```')
      this.formatted = true
      return
    }
    if (name === 'HR') { out.push('---'); this.formatted = true; return }
    if (name === 'TABLE') {
      const t = this.table(n)
      if (t) { out.push(t); this.formatted = true }
      return
    }
    if (name === 'IMG') {
      const img = this.inline(n)
      if (img) out.push(img)
      return
    }
    // 段落和其它容器：里面有块的就一块一块来，全是行内的就合成一段
    if (BLOCK.has(name) || !hasBlockChild(n)) {
      if (hasBlockChild(n)) return this.children(n, out)
      const t = this.inlineChildren(n).replace(/[ \t]+\n/g, '\n').trim()
      if (t) out.push(escapeLineStart(t))
      return
    }
    this.children(n, out)
  }

  children(n: DomNode, out: string[]): void {
    // 连续的行内节点合成一段
    let run: DomNode[] = []
    const flush = () => {
      if (!run.length) return
      const t = run.map((x) => this.inline(x)).join('').replace(/[ \t]+\n/g, '\n').trim()
      if (t) out.push(escapeLineStart(t))
      run = []
    }
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === 3 || (c.nodeType === 1 && !isBlockNode(c))) run.push(c)
      else { flush(); this.block(c, out) }
    }
    flush()
  }

  inlineChildren(n: DomNode): string {
    return Array.from(n.childNodes).map((c) => this.inline(c)).join('')
  }

  inline(n: DomNode): string {
    if (n.nodeType === 3) return escapeText((n.textContent ?? '').replace(/\s+/g, ' '))
    if (n.nodeType !== 1 || SKIP.has(n.nodeName)) return ''
    const name = n.nodeName.toUpperCase()
    const st = styleOf(n)
    const inner = () => this.inlineChildren(n)
    const wrap = (mark: string, s: string) => {
      const m = /^(\s*)(.*?)(\s*)$/s.exec(s)!
      if (!m[2]) return s
      this.formatted = true
      return `${m[1]}${mark}${m[2]}${mark}${m[3]}`
    }
    switch (name) {
      case 'BR': return '\n'
      case 'B': case 'STRONG':
        // Google 文档把整段包在 <b style="font-weight:normal"> 里
        return /font-weight\s*:\s*(normal|[1-4]00)/.test(st) ? inner() : wrap('**', inner())
      case 'I': case 'EM': case 'CITE': case 'DFN': return wrap('*', inner())
      case 'S': case 'DEL': case 'STRIKE': return wrap('~~', inner())
      case 'CODE': case 'KBD': case 'SAMP': case 'TT': {
        const t = (n.textContent ?? '').replace(/\s+/g, ' ')
        if (!t.trim()) return t
        this.formatted = true
        const fence = t.includes('`') ? '``' : '`'
        return `${fence}${t}${fence}`
      }
      case 'A': {
        const href = n.getAttribute?.('href') ?? ''
        const text = inner()
        if (!/^(https?:|mailto:)/i.test(href) || !text.trim()) return text
        this.formatted = true
        return `[${text.trim()}](${href.replace(/[()\s]/g, (c) => encodeURIComponent(c))})`
      }
      case 'IMG': {
        const src = n.getAttribute?.('src') ?? ''
        const alt = (n.getAttribute?.('alt') ?? '').replace(/[[\]]/g, '')
        if (!/^https?:/i.test(src)) return alt
        this.formatted = true
        return `![${alt}](${src})`
      }
      case 'SUP': case 'SUB': return inner()
    }
    let s = inner()
    if (isBoldStyle(st)) s = wrap('**', s)
    if (isItalicStyle(st)) s = wrap('*', s)
    return s
  }

  list(n: DomNode, ordered: boolean, depth = 0): string {
    const lines: string[] = []
    let i = 1
    for (const li of Array.from(n.childNodes)) {
      if (li.nodeType !== 1 || li.nodeName.toUpperCase() !== 'LI') continue
      const marker = ordered ? `${i++}.` : '-'
      const pad = ' '.repeat(marker.length + 1)
      const own: DomNode[] = []
      const nested: string[] = []
      for (const c of Array.from(li.childNodes)) {
        const cn = c.nodeName.toUpperCase()
        if (cn === 'UL' || cn === 'OL') nested.push(this.list(c, cn === 'OL', depth + 1))
        else own.push(c)
      }
      // <li><p>…</p></li> 也当一行
      const text = own.map((c) => (c.nodeType === 1 && isBlockNode(c) ? this.inlineChildren(c) : this.inline(c))).join(' ').replace(/\s+/g, ' ').trim()
      // GitHub 之类的待办列表：<li><input type="checkbox" checked> …
      const box = findCheckbox(li)
      const check = box ? (box.getAttribute?.('checked') != null ? '[x] ' : '[ ] ') : ''
      lines.push(`${marker} ${check}${text}`)
      for (const sub of nested) lines.push(sub.replace(/^/gm, pad))
    }
    this.formatted = true
    return lines.join('\n')
  }

  table(n: DomNode): string | null {
    const rows: string[][] = []
    const walk = (x: DomNode) => {
      for (const c of Array.from(x.childNodes)) {
        const cn = c.nodeName.toUpperCase()
        if (cn === 'TR') {
          const cells = Array.from(c.childNodes)
            .filter((d) => /^(TD|TH)$/i.test(d.nodeName))
            .map((d) => this.inlineChildren(d).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|'))
          if (cells.length) rows.push(cells)
        } else if (/^(THEAD|TBODY|TFOOT)$/.test(cn)) walk(c)
      }
    }
    walk(n)
    if (!rows.length) return null
    // 只有一格的"表格"多半是网页排版用的，当普通文字
    if (rows.every((r) => r.length < 2)) return rows.map((r) => r[0]).join('\n\n')
    return formatTable({ rows, align: [] }).join('\n')
  }
}

const isBlockNode = (n: DomNode) => {
  const name = n.nodeName.toUpperCase()
  return BLOCK.has(name) || /^(H[1-6]|UL|OL|LI|BLOCKQUOTE|PRE|HR|TABLE|TR)$/.test(name)
}
const hasBlockChild = (n: DomNode) => Array.from(n.childNodes).some((c) => c.nodeType === 1 && isBlockNode(c))
function findCheckbox(n: DomNode): DomNode | null {
  for (const c of Array.from(n.childNodes)) {
    if (c.nodeType !== 1) continue
    if (c.nodeName.toUpperCase() === 'INPUT' && (c.getAttribute?.('type') ?? '').toLowerCase() === 'checkbox') return c
    if (!/^(UL|OL)$/i.test(c.nodeName)) {
      const f = findCheckbox(c)
      if (f) return f
    }
  }
  return null
}
const firstChildCode = (n: DomNode) => Array.from(n.childNodes).find((c) => c.nodeName.toUpperCase() === 'CODE')

/** 代码编辑器（VS Code 等）复制出来的 HTML：整段等宽字体，按纯文字粘贴 */
function looksLikeCode(root: DomNode): boolean {
  const els: DomNode[] = []
  const walk = (x: DomNode) => { for (const c of Array.from(x.childNodes)) if (c.nodeType === 1) { els.push(c); if (els.length < 30) walk(c) } }
  walk(root)
  const first = els.find((e) => !SKIP.has(e.nodeName) && !/^(HTML|HEAD|BODY)$/i.test(e.nodeName))
  if (!first) return false
  const st = styleOf(first)
  return /white-space\s*:\s*pre/.test(st) || (isMonoStyle(st) && first.nodeName.toUpperCase() !== 'CODE')
}

/** 带格式的 HTML 转成 Markdown；里面没有任何格式（或者是代码编辑器复制的）时返回 null，按纯文字粘贴 */
export function htmlToMarkdown(body: DomNode): string | null {
  if (looksLikeCode(body)) return null
  const c = new Converter()
  const out: string[] = []
  c.children(body, out)
  if (!c.formatted) return null
  const md = out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
  return md || null
}

// —— PDF 复制的断行 ——

const LIGATURES: Record<string, string> = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'ft', 'ﬆ': 'st' }
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u
const ENDS_SENTENCE = /[.!?。！？:：;；"”)）\]]$/
/** 一看就不是 PDF 正文的：列表、标题、代码、表格 */
const STRUCTURED = /^\s*([-*+•·]\s|\d+[.)]\s|#{1,6}\s|>|```|~~~|\|)/

/**
 * 从 PDF 复制的文字：每行在版面边上断开，单词被连字符拆成两半。
 * 看起来是这种文字时（多数行差不多长、行尾多半不是句号）接成整段；不像就返回 null，原样粘贴。
 * 短行并且以句号结尾的当作段落结束。
 */
export function unwrapPdfText(text: string): string | null {
  const lines = text.replace(/\r\n?/g, '\n').replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c] ?? c).split('\n').map((l) => l.replace(/\s+$/, ''))
  const filled = lines.filter((l) => l.trim())
  if (filled.length < 2 || filled.some((l) => STRUCTURED.test(l))) return null
  const widths = filled.map((l) => textWidth(l.trim())).sort((a, b) => a - b)
  const typical = widths[Math.floor(widths.length * 0.8)] ?? widths[widths.length - 1]!
  if (typical < 40) return null
  // 除了每段的最后一行，其余各行都应该接近满行、而且多半不以句号结尾
  const inner = lines.filter((l, i) => l.trim() && lines[i + 1]?.trim())
  if (!inner.length) return null
  const full = inner.filter((l) => textWidth(l.trim()) >= typical * 0.6).length
  const open = inner.filter((l) => !ENDS_SENTENCE.test(l.trim())).length
  if (full < inner.length * 0.7 || open < inner.length * 0.5) return null

  const paras: string[] = []
  let cur = ''
  const end = () => { if (cur.trim()) paras.push(cur.trim()); cur = '' }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim()
    if (!l) { end(); continue }
    if (!cur) cur = l
    else if (/[A-Za-z]-$/.test(cur) && /^[a-z]/.test(l)) cur = cur.slice(0, -1) + l
    else if (CJK.test(cur.slice(-1)) || CJK.test(l[0]!)) cur += l
    else cur += ' ' + l
    // 短行、句号结尾：这一段完了
    if (ENDS_SENTENCE.test(l) && textWidth(l) < typical * 0.7) end()
  }
  end()
  const out = paras.join('\n\n')
  return out === text.trim() ? null : out
}

// —— 编辑器里的粘贴 ——

function inCode(view: EditorView): boolean {
  const pos = view.state.selection.main.from
  for (let n: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(view.state).resolveInner(pos, -1); n; n = n.parent) {
    if (/^(FencedCode|CodeBlock|InlineCode|CodeText)$/.test(n.name)) return true
  }
  return false
}

export const smartPaste = EditorView.domEventHandlers({
  paste(e, view) {
    const data = e.clipboardData
    if (!data || inCode(view) || view.state.selection.ranges.length > 1) return false
    const plain = data.getData('text/plain')
    const html = data.getData('text/html')
    let md: string | null = null
    if (html) {
      try {
        md = htmlToMarkdown(new DOMParser().parseFromString(html, 'text/html').body as unknown as DomNode)
      } catch {
        md = null
      }
    }
    if (!md && plain) md = unwrapPdfText(plain)
    if (!md || md === plain) return false
    e.preventDefault()
    // 先按原样的纯文字放进去，再换成转好的：⌘Z 一次回到纯文字
    const raw = plain || md
    view.dispatch(view.state.replaceSelection(raw), { userEvent: 'input.paste', scrollIntoView: true })
    const end = view.state.selection.main.head
    view.dispatch({
      changes: { from: end - raw.length, to: end, insert: md },
      selection: { anchor: end - raw.length + md.length },
      userEvent: 'input.paste',
      annotations: isolateHistory.of('full'),
      scrollIntoView: true
    })
    return true
  }
})
