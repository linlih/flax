// 表格（GFM）：光标不在表格里时显示成真正的表格；在里面时显示对齐好的源码，
// Tab / Shift+Tab 在格子之间跳，回车到下一行的第一格（没有就加一行），空行上回车离开表格。
// 每次跳格子时整张表重新对齐（Obsidian 的 Advanced Tables、Typora 都是这样），中文按两个字宽算。
import { syntaxTree } from '@codemirror/language'
import { EditorSelection, type EditorState, type StateCommand } from '@codemirror/state'
import { WidgetType, type EditorView } from '@codemirror/view'
import { findInlineMath, renderTex } from './noteMath'

export type Align = 'left' | 'center' | 'right' | null

export interface Table {
  rows: string[][]
  align: Align[]
}

/** 按没转义的 | 切开一行；两头的 | 可有可无 */
export function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '\\|'; i++; continue }
    if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue }
    cur += s[i]
  }
  cells.push(cur.trim())
  return cells
}

const DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
export const isDelimiterRow = (line: string) => DELIM.test(line) && line.includes('-')
/** 像表格的一行：至少有一个 | 把它分成两格 */
export const isTableRow = (line: string) => /\|/.test(line) && splitRow(line).length >= 2

export function parseTable(lines: string[]): Table {
  const rows: string[][] = []
  let align: Align[] = []
  lines.forEach((l, i) => {
    if (i === 1 && isDelimiterRow(l)) {
      align = splitRow(l).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null))
    } else rows.push(splitRow(l))
  })
  return { rows, align }
}

/** 显示宽度：中日韩文字和全角符号算两个 */
export function textWidth(s: string): number {
  let w = 0
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]/u.test(ch) ? 2 : 1
  return w
}

/** 对齐好的源码 */
export function formatTable(t: Table): string[] {
  const cols = Math.max(1, ...t.rows.map((r) => r.length))
  const rows = t.rows.map((r) => Array.from({ length: cols }, (_, i) => r[i] ?? ''))
  const width = Array.from({ length: cols }, (_, i) => Math.max(3, ...rows.map((r) => textWidth(r[i]!))))
  const pad = (s: string, w: number, a: Align) => {
    const gap = w - textWidth(s)
    if (a === 'right') return ' '.repeat(gap) + s
    if (a === 'center') return ' '.repeat(Math.floor(gap / 2)) + s + ' '.repeat(Math.ceil(gap / 2))
    return s + ' '.repeat(gap)
  }
  const line = (r: string[]) => '| ' + r.map((c, i) => pad(c, width[i]!, t.align[i] ?? null)).join(' | ') + ' |'
  const delim =
    '| ' +
    width
      .map((w, i) => {
        const a = t.align[i] ?? null
        if (a === 'center') return ':' + '-'.repeat(w - 2) + ':'
        if (a === 'right') return '-'.repeat(w - 1) + ':'
        if (a === 'left') return ':' + '-'.repeat(w - 1)
        return '-'.repeat(w)
      })
      .join(' | ') +
    ' |'
  return [line(rows[0]!), delim, ...rows.slice(1).map(line)]
}

/** 格式化后第几行（源码行，含分隔行）第几格的文字开头在这一行里的位置 */
function cellStart(line: string, cell: number): number {
  let n = -1
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && line[i + 1] === '|') { i++; continue }
    if (line[i] === '|') {
      n++
      if (n === cell) {
        let p = i + 1
        if (line[p] === ' ') p++
        // 居中、靠右的格子前面还有空格；空格子就停在 "| " 后面
        let q = p
        while (line[q] === ' ') q++
        return q < line.length && line[q] !== '|' ? q : Math.min(p, line.length)
      }
    }
  }
  return line.length
}

/** 光标在这一行的第几格 */
function cellAt(line: string, col: number): number {
  let n = -1
  const s = line.trimStart().startsWith('|') ? line : '|' + line
  const shift = s.length - line.length
  for (let i = 0; i < Math.min(col + shift, s.length); i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { i++; continue }
    if (s[i] === '|') n++
  }
  return Math.max(0, n)
}

interface Found {
  /** 表格第一行和最后一行的行号 */
  first: number
  last: number
  lines: string[]
}

/** 光标所在的表格（语法树认出来的 GFM 表格） */
export function tableAt(state: EditorState, pos: number): Found | null {
  const tree = syntaxTree(state)
  for (const side of [1, -1] as const) for (let n: ReturnType<typeof syntaxTree>['topNode'] | null = tree.resolveInner(pos, side); n; n = n.parent) {
    if (n.name !== 'Table') continue
    const first = state.doc.lineAt(n.from).number
    const last = state.doc.lineAt(n.to).number
    const lines: string[] = []
    for (let i = first; i <= last; i++) lines.push(state.doc.line(i).text)
    // 语法树有时把表格后面紧跟的一行也算进来，只留像表格的行
    while (lines.length > 2 && !isTableRow(lines[lines.length - 1]!)) lines.pop()
    return { first, last: first + lines.length - 1, lines }
  }
  return null
}

/** 把表格换成对齐好的样子，光标放到第 row 行（数据行算法：0 是表头，1 起是内容）第 cell 格 */
function rewrite(state: EditorState, f: Found, t: Table, row: number, cell: number) {
  const out = formatTable(t)
  const from = state.doc.line(f.first).from
  const to = state.doc.line(f.last).to
  const text = out.join('\n')
  const srcRow = row === 0 ? 0 : row + 1
  let anchor = from
  for (let i = 0; i < srcRow; i++) anchor += out[i]!.length + 1
  anchor += cellStart(out[srcRow]!, cell)
  return state.update({ changes: { from, to, insert: text }, selection: EditorSelection.cursor(anchor), scrollIntoView: true, userEvent: 'input' })
}

/** 光标在表格的第几行（0 是表头；分隔行算表头）第几格 */
function where(state: EditorState, f: Found): { row: number; cell: number } {
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  const idx = line.number - f.first
  return { row: idx <= 1 ? 0 : idx - 1, cell: cellAt(line.text, head - line.from) }
}

/** Tab：下一格；最后一格再按就加一行 */
export const nextCell: StateCommand = ({ state, dispatch }) => {
  const f = tableAt(state, state.selection.main.head)
  if (!f) return false
  const t = parseTable(f.lines)
  const cols = Math.max(...t.rows.map((r) => r.length))
  let { row, cell } = where(state, f)
  cell++
  if (cell >= cols) {
    cell = 0
    row++
    if (row >= t.rows.length) t.rows.push(Array(cols).fill(''))
  }
  dispatch(rewrite(state, f, t, row, cell))
  return true
}

/** Shift+Tab：上一格 */
export const prevCell: StateCommand = ({ state, dispatch }) => {
  const f = tableAt(state, state.selection.main.head)
  if (!f) return false
  const t = parseTable(f.lines)
  const cols = Math.max(...t.rows.map((r) => r.length))
  let { row, cell } = where(state, f)
  cell--
  if (cell < 0) {
    if (row === 0) cell = 0
    else { row--; cell = cols - 1 }
  }
  dispatch(rewrite(state, f, t, row, cell))
  return true
}

/** 回车：下一行第一格，没有就加一行；在全空的最后一行上回车就删掉这行、离开表格 */
export const tableEnter: StateCommand = ({ state, dispatch }) => {
  if (!state.selection.main.empty) return false
  const f = tableAt(state, state.selection.main.head)
  if (!f) return startTable({ state, dispatch })
  const t = parseTable(f.lines)
  const cols = Math.max(...t.rows.map((r) => r.length))
  const { row } = where(state, f)
  const isLast = row === t.rows.length - 1
  if (isLast && row > 0 && t.rows[row]!.every((c) => !c.trim())) {
    t.rows.pop()
    const out = formatTable(t).join('\n')
    const from = state.doc.line(f.first).from
    const to = state.doc.line(f.last).to
    // 表格后面空一行再写，不然下一段会被当成表格的一行
    dispatch(state.update({ changes: { from, to, insert: out + '\n\n' }, selection: EditorSelection.cursor(from + out.length + 2), scrollIntoView: true, userEvent: 'input' }))
    return true
  }
  if (isLast) t.rows.push(Array(cols).fill(''))
  // 一行一行往下填：回到下一行的第一格
  dispatch(rewrite(state, f, t, row + 1, 0))
  return true
}

/** 刚打完表头 "| 模型 | 分数 |" 回车：补上分隔行和一行空的，光标放进第一格 */
const startTable: StateCommand = ({ state, dispatch }) => {
  const line = state.doc.lineAt(state.selection.main.head)
  if (state.selection.main.head !== line.to || !/^\s*\|.*\|\s*$/.test(line.text) || !isTableRow(line.text)) return false
  const prev = line.number > 1 ? state.doc.line(line.number - 1).text : ''
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1).text : ''
  if (isTableRow(prev) || isDelimiterRow(next)) return false
  const t: Table = { rows: [splitRow(line.text), []], align: [] }
  t.rows[1] = Array(t.rows[0]!.length).fill('')
  const out = formatTable(t)
  const text = out.join('\n')
  const anchor = line.from + out[0]!.length + 1 + out[1]!.length + 1 + cellStart(out[2]!, 0)
  dispatch(state.update({ changes: { from: line.from, to: line.to, insert: text }, selection: EditorSelection.cursor(anchor), scrollIntoView: true, userEvent: 'input' }))
  return true
}

/** 斜杠菜单"表格"：两列两行的空表，光标在第一个表头格子 */
export function emptyTable(): { text: string; cursor: number } {
  const out = formatTable({ rows: [['', ''], ['', '']], align: [] })
  return { text: out.join('\n'), cursor: cellStart(out[0]!, 0) }
}

// —— 显示成表格 ——

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 格子里的行内 Markdown：加粗、斜体、代码、删除线、链接、公式 */
export function cellHtml(src: string): string {
  const math = findInlineMath(src)
  let out = ''
  let at = 0
  for (const m of [...math, { from: src.length, to: src.length, tex: '' }]) {
    out += inline(src.slice(at, m.from))
    if (m.tex) out += renderTex(m.tex, false)
    at = m.to
  }
  return out
}

function inline(s: string): string {
  const codes: string[] = []
  let h = esc(s.replace(/\\\|/g, '|')).replace(/`([^`]+)`/g, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`)
  h = h
    .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, a: string, b?: string) => `<span class="cm-lp-link">${b || a}</span>`)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '<span class="cm-lp-link">$1</span>')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a?: string, b?: string) => `<strong>${a ?? b}</strong>`)
    .replace(/\*([^*]+)\*|(?<![\w])_([^_]+)_(?![\w])/g, (_, a?: string, b?: string) => `<em>${a ?? b}</em>`)
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
  return h.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code class="cm-lp-code">${codes[Number(i)]}</code>`)
}

/** 排好的表格；点格子把光标放到那一格的源码里 */
export class TableWidget extends WidgetType {
  constructor(readonly source: string) { super() }
  eq(o: TableWidget) { return o.source === this.source }
  toDOM(view: EditorView) {
    const lines = this.source.split('\n')
    const t = parseTable(lines)
    const cols = Math.max(...t.rows.map((r) => r.length))
    const wrap = document.createElement('div')
    wrap.className = 'cm-lp-table'
    const table = document.createElement('table')
    t.rows.forEach((r, ri) => {
      const tr = document.createElement('tr')
      for (let ci = 0; ci < cols; ci++) {
        const td = document.createElement(ri === 0 ? 'th' : 'td')
        const a = t.align[ci]
        if (a) td.style.textAlign = a
        td.innerHTML = cellHtml(r[ci] ?? '')
        // 源码里这一格的位置
        const srcLine = ri === 0 ? 0 : ri + 1
        let off = 0
        for (let i = 0; i < srcLine; i++) off += lines[i]!.length + 1
        td.dataset['at'] = String(off + cellStart(lines[srcLine]!, ci))
        tr.appendChild(td)
      }
      table.appendChild(tr)
    })
    wrap.appendChild(table)
    wrap.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-at]')
      const at = view.posAtDOM(wrap) + Number(cell?.dataset['at'] ?? 0)
      view.dispatch({ selection: { anchor: Math.min(at, view.state.doc.length) }, scrollIntoView: true })
      view.focus()
    })
    return wrap
  }
  ignoreEvent() { return true }
}
