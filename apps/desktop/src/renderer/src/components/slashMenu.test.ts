import { CompletionContext, type Completion } from '@codemirror/autocomplete'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { expect, test } from 'vitest'
import { matchCommands, slashCommands } from './slashMenu'

/** 在 "|" 处打开 / 菜单，选 label 那一项，返回结果（"|" 是光标） */
function pick(doc: string, label: string): string {
  const pos = doc.indexOf('|')
  let state = EditorState.create({ doc: doc.replace('|', ''), selection: { anchor: pos }, extensions: [markdown({ base: markdownLanguage })] })
  const r = slashCommands(new CompletionContext(state, pos, false))
  if (!r) return 'no menu'
  const opt = r.options.find((o) => o.label === label) as Completion & { apply: (v: EditorView, c: Completion, f: number, t: number) => void }
  const view = { get state() { return state }, dispatch: (spec: TransactionSpec) => { state = state.update(spec).state } } as unknown as EditorView
  opt.apply(view, opt, r.from, pos)
  const head = state.selection.main.head
  const text = state.doc.toString()
  return text.slice(0, head) + '|' + text.slice(head)
}

test('turns the current line into a heading, list, task or quote', () => {
  expect(pick('/h2|', '标题 2')).toBe('## |')
  expect(pick('hello /bt|', '标题 1')).toBe('# hello |')
  expect(pick('- item /db|', '待办')).toBe('- [ ] item |')
  expect(pick('## title /zw|', '正文')).toBe('title |')
  expect(pick('a\n/yy|', '引用')).toBe('a\n> |')
})

test('inserts blocks and inline marks', () => {
  expect(pick('x /dm|', '代码块')).toBe('x \n```\n|\n```')
  expect(pick('/ct|', '粗体')).toBe('**|**')
  expect(pick('/|', '分隔线')).toBe('---\n|')
})

test('only opens at line start or after a space, never in code or URLs', () => {
  expect(pick('http:/|', '正文')).toBe('no menu')
  expect(pick('`a /|`', '正文')).toBe('no menu')
  expect(matchCommands('标题').length).toBe(3)
  expect(matchCommands('lb').map((c) => c.label)).toEqual(['无序列表', '有序列表'])
})
