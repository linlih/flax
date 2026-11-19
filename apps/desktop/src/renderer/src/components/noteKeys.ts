// 段落的打字手感（照 Typora）：
//   - 普通段落、标题里回车 = 新段落（文件里是空一行，Markdown 才认它是两段）；Shift+回车 = 段内换行；
//   - 段首退格：和上一段接起来（一次删掉中间的空行），而不是先删空行再删换行；
//   - 段落之间的空行显示得很窄（见 livePreview 的 cm-lp-gap），上下方向键跳过它们，光标不会停在缝里。
// 列表、引用、代码块、表格里的回车照旧（续上列表符号等），不归这里管。
import { syntaxTree } from '@codemirror/language'
import { EditorSelection, type EditorState, type StateCommand } from '@codemirror/state'
import type { Command, EditorView } from '@codemirror/view'

/** pos 所在的顶层块（Document 的直接子节点）的名字 */
export function topBlock(state: EditorState, pos: number): string | null {
  let n: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(pos, 1)
  let name: string | null = null
  for (; n && n.name !== 'Document'; n = n.parent) name = n.name
  return name
}

const isBlank = (state: EditorState, n: number) => n >= 1 && n <= state.doc.lines && !state.doc.line(n).text.trim()
const PARAGRAPHISH = /^(Paragraph|ATXHeading\d)$/

/** 第 n 行在没写完的 $$公式$$ 里（从这一段开头数 $$） */
export function inDisplayMath(state: EditorState, n: number): boolean {
  let start = n
  while (start > 1 && !isBlank(state, start - 1)) start--
  let open = false
  for (let i = start; i <= n; i++) {
    const t = state.doc.line(i).text.trim()
    if (open) {
      if (t.endsWith('$$')) open = false
    } else if (t.startsWith('$$')) {
      const rest = t.slice(2)
      if (!(rest.length >= 2 && rest.endsWith('$$'))) open = true
    }
  }
  return open
}

/** 回车：普通段落或标题里开一个新段落 */
export const newParagraph: StateCommand = ({ state, dispatch }) => {
  if (state.selection.ranges.length > 1) return false
  const sel = state.selection.main
  const line = state.doc.lineAt(sel.from)
  if (!line.text.trim() || state.doc.lineAt(sel.to).number !== line.number) return false
  // $$公式$$ 里的回车只是换行，不然公式被空行断开
  if (inDisplayMath(state, line.number)) return false
  if (!PARAGRAPHISH.test(topBlock(state, line.from) ?? '')) return false
  // 光标后面紧跟的空格不带到新段落
  const after = state.sliceDoc(sel.to, line.to)
  const to = sel.to + (after.length - after.trimStart().length)
  dispatch(state.update({ changes: { from: sel.from, to, insert: '\n\n' }, selection: EditorSelection.cursor(sel.from + 2), scrollIntoView: true, userEvent: 'input' }))
  return true
}

/** Shift+回车：段内换行。列表项里换行后对齐到项目文字，引用里续上 "> " */
export const softBreak: StateCommand = ({ state, dispatch }) => {
  const tr = state.changeByRange((r) => {
    const line = state.doc.lineAt(r.from)
    let insert = '\n'
    const block = topBlock(state, line.from)
    if (block === 'Blockquote') insert += /^\s*(>\s?)+/.exec(line.text)?.[0] ?? ''
    else if (block === 'BulletList' || block === 'OrderedList') {
      const m = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/.exec(line.text)
      insert += m ? ' '.repeat(m[0].length) : /^\s*/.exec(line.text)![0]
    }
    return { changes: { from: r.from, to: r.to, insert }, range: EditorSelection.cursor(r.from + insert.length) }
  })
  dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input' }))
  return true
}

/**
 * 退格：
 *   - 空行上、上一行也是空行（刚回车开的新段落，什么也没写）：回到上一段末尾；
 *   - 段落开头、上一行是空行、再上面是段落或标题：和上一段接起来。
 */
export const joinParagraph: StateCommand = ({ state, dispatch }) => {
  if (state.selection.ranges.length > 1) return false
  const sel = state.selection.main
  if (!sel.empty) return false
  const line = state.doc.lineAt(sel.head)
  if (sel.head !== line.from || line.number < 3 || !isBlank(state, line.number - 1) || isBlank(state, line.number - 2)) return false
  const prev = state.doc.line(line.number - 2)
  if (!PARAGRAPHISH.test(topBlock(state, prev.from) ?? '')) return false
  if (line.text.trim() && !PARAGRAPHISH.test(topBlock(state, line.from) ?? '')) return false
  if (line.text.trim() && /^ATXHeading/.test(topBlock(state, line.from) ?? '')) return false
  // 空行（新开的段落还没写字）只是退回去；有字的段落接到上一段后面
  const insert = line.text.trim() && !/\s$/.test(prev.text) && !/^\s/.test(line.text) && needsSpace(prev.text, line.text) ? ' ' : ''
  dispatch(state.update({ changes: { from: prev.to, to: line.from, insert }, selection: EditorSelection.cursor(prev.to + insert.length), scrollIntoView: true, userEvent: 'delete.backward' }))
  return true
}

/** 两段接起来时中间要不要空格：中文接中文不要，英文接英文要 */
function needsSpace(a: string, b: string): boolean {
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u
  return !(cjk.test(a.slice(-1)) || cjk.test(b.slice(0, 1)))
}

/** 段落间的空行：上下移动时跳过（代码块里的空行不跳） */
export function isGapLine(state: EditorState, n: number): boolean {
  if (!isBlank(state, n) || n === 1 || n === state.doc.lines) return false
  for (let x: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(state.doc.line(n).from, 1); x; x = x.parent) {
    if (x.name === 'FencedCode' || x.name === 'CodeBlock' || x.name === 'HTMLBlock') return false
  }
  return true
}

const moveSkippingGaps =
  (forward: boolean): Command =>
  (view: EditorView) => {
    const { state } = view
    if (state.selection.ranges.length > 1 || !state.selection.main.empty) return false
    const start = state.selection.main
    // 本来就停在空行上（比如点进去的）就照常移动
    if (isGapLine(state, state.doc.lineAt(start.head).number)) return false
    let r = view.moveVertically(start, forward)
    for (let i = 0; i < 4 && isGapLine(state, state.doc.lineAt(r.head).number); i++) {
      const next = view.moveVertically(r, forward)
      if (next.head === r.head) break
      r = next
    }
    if (r.head === start.head) return false
    view.dispatch({ selection: EditorSelection.create([r]), scrollIntoView: true, userEvent: 'select' })
    return true
  }

export const cursorDownSkippingGaps = moveSkippingGaps(true)
export const cursorUpSkippingGaps = moveSkippingGaps(false)

/** 打完 ```python 回车：补上结尾的 ```，光标放在中间（Typora 的做法） */
export const closeCodeFence: StateCommand = ({ state, dispatch }) => {
  const sel = state.selection.main
  if (state.selection.ranges.length > 1 || !sel.empty) return false
  const line = state.doc.lineAt(sel.head)
  const m = /^(\s*)(`{3,}|~{3,})[^`\s]*\s*$/.exec(line.text)
  if (!m || sel.head !== line.to) return false
  let fenced: ReturnType<typeof syntaxTree>['topNode'] | null = null
  for (let n: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(line.from, 1); n; n = n.parent) if (n.name === 'FencedCode') { fenced = n; break }
  if (!fenced || fenced.from !== line.from + m[1]!.length) return false
  // 已经有结尾的就不补
  const last = state.doc.lineAt(fenced.to)
  if (last.number > line.number && new RegExp(`^\\s*${m[2]![0] === '`' ? '`' : '~'}{${m[2]!.length},}\\s*$`).test(last.text)) return false
  const indent = m[1]!
  dispatch(state.update({ changes: { from: line.to, insert: `\n${indent}\n${indent}${m[2]}` }, selection: EditorSelection.cursor(line.to + 1 + indent.length), scrollIntoView: true, userEvent: 'input' }))
  return true
}
