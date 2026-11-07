import { EditorSelection, EditorState, type StateCommand, type Transaction } from '@codemirror/state'
import { expect, test } from 'vitest'
import { exitEmptyQuote, toggleTask, toggleWrap } from './livePreview'

/** 在文档上跑一个命令；"|" 是光标，"«" "»" 是选区 */
function run(cmd: StateCommand, doc: string): string | false {
  const a = doc.indexOf('«'), b = doc.indexOf('»')
  const sel = a >= 0 ? EditorSelection.single(a, b - 1) : EditorSelection.cursor(doc.indexOf('|'))
  let state = EditorState.create({ doc: doc.replace(/[|«»]/g, ''), selection: sel })
  const ok = cmd({ state, dispatch: (tr: Transaction) => { state = tr.state } })
  if (!ok) return false
  const s = state.selection.main
  const text = state.doc.toString()
  return s.empty ? text.slice(0, s.head) + '|' + text.slice(s.head) : text.slice(0, s.from) + '«' + text.slice(s.from, s.to) + '»' + text.slice(s.to)
}

test('empty top-level item or quote exits with a blank line', () => {
  expect(run(exitEmptyQuote, '- a\n- |')).toBe('- a\n\n|')
  expect(run(exitEmptyQuote, '- [ ] a\n- [ ] |')).toBe('- [ ] a\n\n|')
  expect(run(exitEmptyQuote, '> a\n> |')).toBe('> a\n\n|')
  expect(run(exitEmptyQuote, '1. a\n2. |')).toBe('1. a\n\n|')
})

test('empty nested item outdents one level', () => {
  expect(run(exitEmptyQuote, '- a\n  - b\n  - |')).toBe('- a\n  - b\n- |')
})

test('non-empty lines are left to the default Enter', () => {
  expect(run(exitEmptyQuote, '- a|')).toBe(false)
  expect(run(exitEmptyQuote, 'plain|')).toBe(false)
})

test('toggle wrap adds and removes markers', () => {
  expect(run(toggleWrap('**'), 'a «bc» d')).toBe('a **«bc»** d')
  expect(run(toggleWrap('**'), 'a **«bc»** d')).toBe('a «bc» d')
})

test('toggle task cycles a line into a task', () => {
  expect(run(toggleTask, 'buy milk|')).toMatch(/^- \[ \] buy milk/)
})
