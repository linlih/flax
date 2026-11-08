// 所见即所得的 Markdown（"实时预览"）：文件始终是纯 Markdown，编辑器里直接显示排好的样子。
// 交互模型和 Obsidian 的实时预览、Typora 一样：
//   - 标题、加粗、斜体、链接、引用、列表、待办、代码、分隔线就地显示成效果；
//   - Markdown 符号平时藏起来，光标移到那一处（行内元素）或那一行（标题、引用、分隔线）时露出来，方便改；
//   - 列表符号显示成圆点，待办显示成能点的勾选框。
// 这里是自己按 CodeMirror 6 的语法树实现的，没有用别家的代码。
import { syntaxTree } from '@codemirror/language'
import { EditorSelection, type EditorState, type Range, type StateCommand } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { kbd } from '../lib/platform'

// —— 小部件 ——
class BulletWidget extends WidgetType {
  eq() { return true }
  toDOM() {
    const s = document.createElement('span')
    s.className = 'cm-lp-bullet'
    s.textContent = '•'
    return s
  }
}
class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly at: number) { super() }
  eq(o: CheckboxWidget) { return o.checked === this.checked && o.at === this.at }
  toDOM(view: EditorView) {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-lp-check'
    box.checked = this.checked
    box.setAttribute('aria-label', this.checked ? '已完成' : '未完成')
    box.addEventListener('mousedown', (e) => {
      e.preventDefault()
      // "[ ]" 和 "[x]" 中间那个字符
      view.dispatch({ changes: { from: this.at + 1, to: this.at + 2, insert: this.checked ? ' ' : 'x' } })
    })
    return box
  }
  ignoreEvent() { return false }
}
class RuleWidget extends WidgetType {
  eq() { return true }
  toDOM() {
    const s = document.createElement('span')
    s.className = 'cm-lp-hr'
    return s
  }
}

const hide = Decoration.replace({})
const bullet = Decoration.replace({ widget: new BulletWidget() })
const rule = Decoration.replace({ widget: new RuleWidget() })
const mark = (cls: string, attrs?: Record<string, string>) => Decoration.mark({ class: cls, attributes: attrs })
const line = (cls: string) => Decoration.line({ class: cls })

const M = {
  strong: mark('cm-lp-strong'),
  em: mark('cm-lp-em'),
  strike: mark('cm-lp-strike'),
  code: mark('cm-lp-code'),
  link: mark('cm-lp-link', { title: kbd('⌘ 点击打开') }),
  anno: mark('cm-lp-link cm-annolink', { title: '点击跳回原文' }),
  wiki: mark('cm-lp-link cm-wikilink', { title: kbd('⌘ 点击打开') }),
  faint: mark('cm-lp-faint'),
  done: mark('cm-lp-done')
}
const L = {
  h: [1, 2, 3, 4, 5, 6].map((n) => line(`cm-lp-h cm-lp-h${n}`)),
  quote: line('cm-lp-quote'),
  excerpt: Decoration.line({ class: 'cm-lp-quote cm-lp-excerpt', attributes: { title: kbd('点击跳到论文里这一段（⌥ 点击可以修改）') } }),
  code: line('cm-lp-codeblock'),
  codeFirst: line('cm-lp-codeblock cm-lp-codeblock-first'),
  codeLast: line('cm-lp-codeblock cm-lp-codeblock-last')
}

const ANNO_RE = /\((?:flax|paper):\/\/annotation\/([\w-]+)\)/

/** pos 所在的摘录引用块（"> 原文" + "> [第 N 页](flax://annotation/…)"）和它指向的批注 */
export function excerptAt(state: EditorState, pos: number): { id: string; from: number; to: number } | null {
  for (let n: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name !== 'Blockquote') continue
    const m = ANNO_RE.exec(state.doc.sliceString(n.from, n.to))
    return m ? { id: m[1]!, from: n.from, to: n.to } : null
  }
  return null
}

function build(view: EditorView): { all: DecorationSet; atomic: DecorationSet } {
  const { state } = view
  const out: Range<Decoration>[] = []
  const focused = view.hasFocus
  const sel = state.selection.ranges
  /** 选区碰到这一段（只在编辑器有焦点时算，失焦时整篇都显示成排好的样子） */
  const touches = (from: number, to: number) => focused && sel.some((r) => r.from <= to && r.to >= from)
  const lineTouched = (pos: number) => {
    const l = state.doc.lineAt(pos)
    return touches(l.from, l.to)
  }
  /** 符号后面紧跟的一个空格也一起藏 */
  const withSpace = (to: number) => (state.doc.sliceString(to, to + 1) === ' ' ? to + 1 : to)

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const n = node.name
        // 标题：整行放大；"# " 不在这一行编辑时藏起来
        const h = /^ATXHeading(\d)$/.exec(n)
        if (h) {
          out.push(L.h[Number(h[1]) - 1]!.range(state.doc.lineAt(node.from).from))
          return
        }
        if (n === 'HeaderMark') {
          const parent = node.node.parent?.name ?? ''
          if (parent.startsWith('ATXHeading') && !lineTouched(node.from)) out.push(hide.range(node.from, withSpace(node.to)))
          return
        }
        if (n === 'StrongEmphasis') out.push(M.strong.range(node.from, node.to))
        else if (n === 'Emphasis') out.push(M.em.range(node.from, node.to))
        else if (n === 'Strikethrough') out.push(M.strike.range(node.from, node.to))
        else if (n === 'InlineCode') out.push(M.code.range(node.from, node.to))
        if (n === 'EmphasisMark' || n === 'StrikethroughMark' || (n === 'CodeMark' && node.node.parent?.name === 'InlineCode')) {
          const p = node.node.parent!
          if (!touches(p.from, p.to)) out.push(hide.range(node.from, node.to))
          else out.push(M.faint.range(node.from, node.to))
          return
        }
        // 链接：[文字](地址) 平时只显示文字
        if (n === 'Link') {
          const url = node.node.getChild('URL')
          const href = url ? state.doc.sliceString(url.from, url.to) : ''
          const label = node.node.getChildren('LinkMark')
          const open = label[0]
          const close = label[1]
          if (open && close && close.from > open.to) {
            out.push((/^(flax|paper):\/\/annotation\//.test(href) ? M.anno : M.link).range(open.to, close.from))
            if (!touches(node.from, node.to)) {
              out.push(hide.range(open.from, open.to), hide.range(close.from, node.to))
            } else {
              out.push(M.faint.range(close.from, node.to))
            }
          }
          return false
        }
        // 引用：左边一条竖线，">" 不在这一行编辑时藏起来
        if (n === 'Blockquote') {
          const deco = ANNO_RE.test(state.doc.sliceString(node.from, node.to)) ? L.excerpt : L.quote
          for (let pos = node.from; pos <= node.to; ) {
            const l = state.doc.lineAt(pos)
            out.push(deco.range(l.from))
            pos = l.to + 1
          }
          return
        }
        if (n === 'QuoteMark') {
          if (!lineTouched(node.from)) out.push(hide.range(node.from, withSpace(node.to)))
          return
        }
        // 无序列表的符号显示成圆点；有序列表保留数字
        if (n === 'ListMark') {
          const list = node.node.parent?.parent?.name
          const isTask = node.node.parent?.getChild('Task')
          if (list === 'BulletList' && !touches(node.from, node.to)) {
            if (isTask) out.push(hide.range(node.from, withSpace(node.to)))
            else out.push(bullet.range(node.from, node.to))
          }
          return
        }
        if (n === 'TaskMarker') {
          const checked = /x/i.test(state.doc.sliceString(node.from, node.to))
          if (!touches(node.from, node.to)) out.push(Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }).range(node.from, node.to))
          if (checked) {
            const task = node.node.parent!
            if (node.to < task.to) out.push(M.done.range(withSpace(node.to), task.to))
          }
          return
        }
        if (n === 'HorizontalRule') {
          if (!lineTouched(node.from)) out.push(rule.range(node.from, node.to))
          return
        }
        // 代码块：等宽、带底色；``` 那两行淡一点
        if (n === 'FencedCode') {
          const first = state.doc.lineAt(node.from).number
          const last = state.doc.lineAt(node.to).number
          for (let i = first; i <= last; i++) {
            const l = state.doc.line(i)
            out.push((i === first ? L.codeFirst : i === last ? L.codeLast : L.code).range(l.from))
          }
          return
        }
        if (n === 'CodeMark' || n === 'CodeInfo') {
          out.push(M.faint.range(node.from, node.to))
          return
        }
        return
      }
    })

    // [[链接]]：Markdown 语法里没有，自己找。平时只显示标题（或 | 后面的别名）
    const text = state.doc.sliceString(from, to)
    for (const m of text.matchAll(/(?<!!)\[\[([^\]\n]+?)\]\]/g)) {
      const start = from + m.index!
      const end = start + m[0].length
      const inner = m[1]!
      const bar = inner.indexOf('|')
      if (touches(start, end)) {
        out.push(M.wiki.range(start + 2, end - 2))
        continue
      }
      if (bar >= 0) {
        out.push(hide.range(start, start + 3 + bar), M.wiki.range(start + 3 + bar, end - 2), hide.range(end - 2, end))
      } else {
        out.push(hide.range(start, start + 2), M.wiki.range(start + 2, end - 2), hide.range(end - 2, end))
      }
    }
  }
  const list = dedupe(out)
  // 光标左右移动时整体跳过的只有被藏起来或换成小部件的那些，加粗之类的样式不算
  return { all: Decoration.set(list, true), atomic: Decoration.set(list.filter((r) => (r.value as { point?: boolean }).point), true) }
}

/** 同一位置的两个替换会冲突（例如待办同时命中两条规则），只留第一个 */
function dedupe(list: Range<Decoration>[]): Range<Decoration>[] {
  const seen = new Set<string>()
  return list.filter((r) => {
    if (!(r.value as { point?: boolean }).point) return true
    const k = `${r.from}:${r.to}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    atomic: DecorationSet
    constructor(v: EditorView) {
      ;({ all: this.decorations, atomic: this.atomic } = build(v))
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        ;({ all: this.decorations, atomic: this.atomic } = build(u.view))
      }
    }
  },
  {
    decorations: (p) => p.decorations,
    // 藏起来的符号，光标左右移动时当作一个整体跳过
    provide: (p) => EditorView.atomicRanges.of((v) => v.plugin(p)?.atomic ?? Decoration.none)
  }
)

// —— 快捷键：⌘B 加粗、⌘I 斜体、⌘E 行内代码、⌘⇧X 删除线、⌘K 链接 ——

/** 选中的文字两边加上（或去掉）符号；没选中时插入一对符号，光标放中间 */
export function toggleWrap(marker: string): StateCommand {
  return ({ state, dispatch }) => {
    const tr = state.changeByRange((r) => {
      const len = marker.length
      const before = state.sliceDoc(r.from - len, r.from)
      const after = state.sliceDoc(r.to, r.to + len)
      if (before === marker && after === marker) {
        return { changes: [{ from: r.from - len, to: r.from }, { from: r.to, to: r.to + len }], range: EditorSelection.range(r.from - len, r.to - len) }
      }
      const inner = state.sliceDoc(r.from, r.to)
      if (inner.length >= 2 * len && inner.startsWith(marker) && inner.endsWith(marker)) {
        return { changes: { from: r.from, to: r.to, insert: inner.slice(len, -len) }, range: EditorSelection.range(r.from, r.to - 2 * len) }
      }
      return { changes: [{ from: r.from, insert: marker }, { from: r.to, insert: marker }], range: EditorSelection.range(r.from + len, r.to + len) }
    })
    dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input' }))
    return true
  }
}

/** ⌘K：选中文字变成 [文字](|)，光标停在地址处；选中的是网址就变成 [|](网址) */
export const insertLink: StateCommand = ({ state, dispatch }) => {
  const tr = state.changeByRange((r) => {
    const text = state.sliceDoc(r.from, r.to)
    if (/^https?:\/\/\S+$/.test(text)) {
      return { changes: { from: r.from, to: r.to, insert: `[](${text})` }, range: EditorSelection.cursor(r.from + 1) }
    }
    const insert = `[${text}]()`
    return { changes: { from: r.from, to: r.to, insert }, range: EditorSelection.cursor(r.from + insert.length - 1) }
  })
  dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input' }))
  return true
}

/** 选中文字时粘贴网址，变成链接（Notion、Obsidian 都是这样） */
export const pasteLink = EditorView.domEventHandlers({
  paste(e, view) {
    const url = e.clipboardData?.getData('text/plain')?.trim() ?? ''
    const r = view.state.selection.main
    if (r.empty || !/^https?:\/\/\S+$/.test(url)) return false
    const text = view.state.sliceDoc(r.from, r.to)
    if (text.includes('\n')) return false
    e.preventDefault()
    view.dispatch({ changes: { from: r.from, to: r.to, insert: `[${text}](${url})` }, userEvent: 'input.paste' })
    return true
  }
})

/** 把一行切换成待办 / 去掉待办（⌘L，和 Obsidian 一样） */
export const toggleTask: StateCommand = ({ state, dispatch }) => {
  const changes: { from: number; to: number; insert: string }[] = []
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
      const l = state.doc.line(n)
      const m = /^(\s*)(?:([-*+]) )?(\[[ xX]\] )?/.exec(l.text)!
      const [all, indent, bulletMark, task] = m
      if (task) changes.push({ from: l.from + indent!.length, to: l.from + all.length, insert: bulletMark ? `${bulletMark} ` : '' })
      else changes.push({ from: l.from + indent!.length, to: l.from + all.length, insert: `${bulletMark ?? '-'} [ ] ` })
    }
  }
  dispatch(state.update({ changes, userEvent: 'input' }))
  return true
}

/**
 * 空的列表项、待办、引用行上回车（Obsidian、Typora 的做法）：
 * 缩进的列表项往外退一级；顶层的就退出，并空一行，
 * 不然下一段会被 Markdown 当成列表或引用的延续（lazy continuation）。
 */
export const exitEmptyQuote: StateCommand = ({ state, dispatch }) => {
  const sel = state.selection.main
  if (!sel.empty) return false
  const line = state.doc.lineAt(sel.head)
  const m = /^(\s*)(>\s*|([-*+]|\d+[.)])\s+(\[[ xX]\]\s*)?)$/.exec(line.text)
  if (!m || sel.head !== line.to) return false
  const indent = m[1]?.length ?? 0
  if (indent > 0 && !m[2]?.startsWith('>')) {
    // 退到上面最近一个缩进更少的列表项那一级
    let to = ''
    for (let n = line.number - 1; n >= 1; n--) {
      const up = /^(\s*)([-*+]|\d+[.)])\s/.exec(state.doc.line(n).text)
      if (up?.[1] != null && up[1].length < indent) { to = up[1]; break }
    }
    dispatch(state.update({ changes: { from: line.from, to: line.from + indent, insert: to }, userEvent: 'delete.dedent' }))
    return true
  }
  const prevBlank = line.number > 1 && !state.doc.line(line.number - 1).text.trim()
  dispatch(state.update({ changes: { from: line.from, to: line.to, insert: prevBlank ? '' : '\n' }, selection: { anchor: line.from + (prevBlank ? 0 : 1) }, userEvent: 'input' }))
  return true
}
