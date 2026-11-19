// 占好几行的块：独立公式 $$…$$ 和表格。CodeMirror 规定跨行替换只能放在 StateField 里（不能放在 ViewPlugin），
// 所以和 livePreview 分开。光标不在块里时整块换成排好的样子；在里面时显示源码（公式下面带着实时预览）。
import { syntaxTree } from '@codemirror/language'
import { StateField, type EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { findMathBlocks, MathWidget } from './noteMath'
import { TableWidget } from './noteTable'

const NOT_HERE = /^(FencedCode|CodeBlock|HTMLBlock|CommentBlock)$/

/** 块的范围（整行），以及光标在不在里面 */
interface Block {
  from: number
  to: number
}

const mathSource = Decoration.line({ class: 'cm-lp-mathsrc' })
const tableSource = Decoration.line({ class: 'cm-lp-tablesrc' })

function insideCode(state: EditorState, pos: number): boolean {
  for (let n: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) if (NOT_HERE.test(n.name)) return true
  return false
}

function build(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = []
  const sel = state.selection.ranges
  const touched = (b: Block) => sel.some((r) => r.from <= b.to && r.to >= b.from)
  const doc = state.doc

  // 表格
  const tables: Block[] = []
  syntaxTree(state).iterate({
    enter: (n) => {
      if (n.name !== 'Table') return
      const first = doc.lineAt(n.from)
      let last = doc.lineAt(n.to)
      // 语法树偶尔把后面紧跟的一行也算进来
      while (last.number > first.number + 1 && !last.text.includes('|')) last = doc.line(last.number - 1)
      tables.push({ from: first.from, to: last.to })
      return false
    }
  })
  for (const b of tables) {
    if (touched(b)) {
      for (let pos = b.from; pos <= b.to; ) {
        const l = doc.lineAt(pos)
        out.push(tableSource.range(l.from))
        pos = l.to + 1
      }
    } else out.push(Decoration.replace({ widget: new TableWidget(doc.sliceString(b.from, b.to)), block: true }).range(b.from, b.to))
  }

  // 独立公式
  const lines = doc.toString().split('\n')
  for (const m of findMathBlocks(lines)) {
    const b = { from: doc.line(m.first + 1).from, to: doc.line(m.last + 1).to }
    if (insideCode(state, b.from) || tables.some((t) => t.from <= b.to && t.to >= b.from)) continue
    if (touched(b)) {
      for (let n = m.first + 1; n <= m.last + 1; n++) out.push(mathSource.range(doc.line(n).from))
      out.push(Decoration.widget({ widget: new MathWidget(m.tex, true, true), block: true, side: 1 }).range(b.to))
    } else out.push(Decoration.replace({ widget: new MathWidget(m.tex, true), block: true }).range(b.from, b.to))
  }
  return Decoration.set(out, true)
}

export const noteBlocks = StateField.define<DecorationSet>({
  create: build,
  update(deco, tr) {
    if (tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state)) return build(tr.state)
    return deco
  },
  provide: (f) => EditorView.decorations.from(f)
})
