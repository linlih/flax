// 输入 / 弹出命令菜单（Notion、Logseq、Obsidian 的斜杠命令）：选一项就把这一行变成标题、列表、待办……
// 或者插入代码块、分隔线、链接。菜单里写着对应的快捷键，用熟了可以直接按。
// 筛选：中文名、英文、拼音首字母都行，比如 /h2、/bt、/标题。
import { startCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import type { EditorView } from '@codemirror/view'
import { insertLink } from './livePreview'

type Apply = (view: EditorView, from: number, to: number) => void

interface Command {
  label: string
  /** 用来筛选的别名（英文、拼音首字母） */
  keys: string[]
  detail?: string
  section: string
  run: Apply
}

/** 行首已有的块标记：标题、引用、待办、列表 */
const BLOCK_MARK = /^(\s*)(?:#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)?/

/** 删掉 "/命令"，把这一行的块标记换成 prefix */
const block =
  (prefix: string): Apply =>
  (view, from, to) => {
    const line = view.state.doc.lineAt(from)
    const m = BLOCK_MARK.exec(line.text)!
    const markFrom = line.from + m[1]!.length
    const markTo = line.from + m[0].length
    const changes = view.state.changes(
      markTo <= from
        ? [{ from: markFrom, to: markTo, insert: prefix }, { from, to }]
        : [{ from, to }, { from: markFrom, to: markTo, insert: prefix }]
    )
    view.dispatch({ changes, selection: { anchor: changes.mapPos(to, 1) }, userEvent: 'input' })
  }

/** 删掉 "/命令"，插入 before|after，光标停在中间 */
const insert =
  (before: string, after = ''): Apply =>
  (view, from, to) => {
    view.dispatch({ changes: { from, to, insert: before + after }, selection: { anchor: from + before.length }, userEvent: 'input' })
  }

/** 代码块、分隔线这种要自己占一行的 */
const ownLine =
  (before: string, after = ''): Apply =>
  (view, from, to) => {
    const line = view.state.doc.lineAt(from)
    const lead = view.state.sliceDoc(line.from, from).trim() ? '\n' : ''
    const tail = view.state.sliceDoc(to, line.to).trim() ? '\n' : ''
    insert(lead + before, after + tail)(view, from, to)
  }

const today = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const COMMANDS: Command[] = [
  { section: '段落', label: '正文', keys: ['text', 'p', 'zw'], run: block('') },
  { section: '段落', label: '标题 1', keys: ['h1', 'heading', 'bt'], detail: '#', run: block('# ') },
  { section: '段落', label: '标题 2', keys: ['h2', 'heading', 'bt'], detail: '##', run: block('## ') },
  { section: '段落', label: '标题 3', keys: ['h3', 'heading', 'bt'], detail: '###', run: block('### ') },
  { section: '段落', label: '无序列表', keys: ['ul', 'list', 'bullet', 'lb', 'wxlb'], detail: '-', run: block('- ') },
  { section: '段落', label: '有序列表', keys: ['ol', 'list', 'number', 'lb', 'yxlb'], detail: '1.', run: block('1. ') },
  { section: '段落', label: '待办', keys: ['todo', 'task', 'check', 'db'], detail: '⌘L', run: block('- [ ] ') },
  { section: '段落', label: '引用', keys: ['quote', 'yy'], detail: '>', run: block('> ') },
  { section: '插入', label: '链接到笔记', keys: ['link', 'page', 'note', 'lj', 'bj'], detail: '[[', run: (v, f, t) => (insert('[[', ']]')(v, f, t), startCompletion(v)) },
  { section: '插入', label: '网页链接', keys: ['url', 'link', 'web', 'lj'], detail: '⌘K', run: (v, f, t) => (v.dispatch({ changes: { from: f, to: t }, selection: { anchor: f } }), insertLink({ state: v.state, dispatch: v.dispatch })) },
  { section: '插入', label: '代码块', keys: ['code', 'dm', 'dmk'], detail: '```', run: ownLine('```\n', '\n```') },
  { section: '插入', label: '分隔线', keys: ['hr', 'divider', 'line', 'fgx'], detail: '---', run: ownLine('---\n') },
  { section: '插入', label: '今天的日期', keys: ['date', 'today', 'rq', 'jt'], run: (v, f, t) => insert(today())(v, f, t) },
  { section: '文字', label: '粗体', keys: ['bold', 'strong', 'ct', 'jc'], detail: '⌘B', run: insert('**', '**') },
  { section: '文字', label: '斜体', keys: ['italic', 'em', 'xt'], detail: '⌘I', run: insert('*', '*') },
  { section: '文字', label: '删除线', keys: ['strike', 'del', 'scx'], detail: '⌘⇧X', run: insert('~~', '~~') },
  { section: '文字', label: '行内代码', keys: ['code', 'inline', 'dm'], detail: '⌘E', run: insert('`', '`') }
]

const SECTION_RANK: Record<string, number> = { 段落: 0, 插入: 1, 文字: 2 }

export function matchCommands(query: string): Command[] {
  const q = query.toLowerCase()
  if (!q) return COMMANDS
  return COMMANDS.filter((c) => c.label.toLowerCase().includes(q) || c.keys.some((k) => k.startsWith(q)))
}

/** 补全来源：行首或空格后输入的 "/xxx" */
export function slashCommands(ctx: CompletionContext): CompletionResult | null {
  const m = ctx.matchBefore(/(?:^|\s)\/[^\s/]{0,12}$/)
  if (!m) return null
  const slash = m.from + m.text.indexOf('/')
  // 代码里的 / 不算
  const node = syntaxTree(ctx.state).resolveInner(slash, -1)
  for (let n: typeof node | null = node; n; n = n.parent) if (/Code/.test(n.name)) return null
  const found = matchCommands(m.text.slice(m.text.indexOf('/') + 1))
  if (!found.length) return null
  return {
    from: slash,
    filter: false,
    options: found.map(
      (c): Completion => ({
        label: c.label,
        detail: c.detail,
        section: { name: c.section, rank: SECTION_RANK[c.section] },
        apply: (view, _c, from, to) => c.run(view, from, to)
      })
    )
  }
}
