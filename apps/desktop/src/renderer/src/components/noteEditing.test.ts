import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState, type StateCommand, type Transaction } from '@codemirror/state'
import { parseHTML } from 'linkedom'
import { describe, expect, test } from 'vitest'
import { headingTitle, isUntitledNote } from '@flax/core'
import { closeCodeFence, joinParagraph, newParagraph, softBreak } from './noteKeys'
import { findInlineMath, findMathBlocks } from './noteMath'
import { formatTable, nextCell, parseTable, prevCell, tableEnter, textWidth } from './noteTable'
import { htmlToMarkdown, unwrapPdfText } from './notePaste'

/** "‸" 是光标。跑一个命令，返回结果（同样用 "‸" 标光标）；命令不管时返回 'pass' */
function run(cmd: StateCommand, doc: string): string {
  const pos = doc.indexOf('‸')
  let state = EditorState.create({ doc: doc.slice(0, pos) + doc.slice(pos + 1), selection: { anchor: pos }, extensions: [markdown({ base: markdownLanguage })] })
  ensureSyntaxTree(state, state.doc.length, 5000)
  let done = false
  cmd({ state, dispatch: (tr: Transaction) => { state = tr.state; done = true } })
  if (!done) return 'pass'
  const head = state.selection.main.head
  const text = state.doc.toString()
  return text.slice(0, head) + '‸' + text.slice(head)
}

describe('paragraph keys', () => {
  test('Enter starts a new paragraph in text and headings', () => {
    expect(run(newParagraph, 'hello‸')).toBe('hello\n\n‸')
    expect(run(newParagraph, 'hel‸lo')).toBe('hel\n\n‸lo')
    expect(run(newParagraph, 'hello‸ world')).toBe('hello\n\n‸world')
    expect(run(newParagraph, '## 核心想法‸')).toBe('## 核心想法\n\n‸')
  })
  test('Enter is left alone in lists, quotes, code, tables and on empty lines', () => {
    expect(run(newParagraph, '- item‸')).toBe('pass')
    expect(run(newParagraph, '> quote‸')).toBe('pass')
    expect(run(newParagraph, '```\ncode‸\n```')).toBe('pass')
    expect(run(newParagraph, 'a\n\n‸')).toBe('pass')
    expect(run(newParagraph, '| a | b |\n| --- | --- |\n| 1 | 2‸ |')).toBe('pass')
  })
  test('Enter inside a $$ formula is a plain newline', () => {
    expect(run(newParagraph, '$$‸')).toBe('pass')
    expect(run(newParagraph, '$$\nx = y‸')).toBe('pass')
    expect(run(newParagraph, '$$\nx\n$$‸')).toBe('$$\nx\n$$\n\n‸')
    expect(run(newParagraph, '$$ x $$‸')).toBe('$$ x $$\n\n‸')
  })
  test('Enter after an opening fence adds the closing one', () => {
    expect(run(closeCodeFence, '```python‸')).toBe('```python\n‸\n```')
    expect(run(closeCodeFence, 'text\n\n~~~‸')).toBe('text\n\n~~~\n‸\n~~~')
    expect(run(closeCodeFence, '```python‸\nx\n```')).toBe('pass')
    expect(run(closeCodeFence, '```py‸thon')).toBe('pass')
  })
  test('Shift+Enter breaks the line, keeping list and quote indentation', () => {
    expect(run(softBreak, 'one‸')).toBe('one\n‸')
    expect(run(softBreak, '- item‸')).toBe('- item\n  ‸')
    expect(run(softBreak, '1. item‸')).toBe('1. item\n   ‸')
    expect(run(softBreak, '> quote‸')).toBe('> quote\n> ‸')
  })
  test('Backspace at a paragraph start joins it to the one above', () => {
    expect(run(joinParagraph, 'first\n\n‸second')).toBe('first ‸second')
    expect(run(joinParagraph, '第一段\n\n‸第二段')).toBe('第一段‸第二段')
    // 刚回车开的空段落：退回上一段末尾
    expect(run(joinParagraph, 'first\n\n‸')).toBe('first‸')
    expect(run(joinParagraph, '# Title\n\n‸')).toBe('# Title‸')
    // 不碰列表、标题、不是段首的
    expect(run(joinParagraph, '- a\n\n‸b')).toBe('pass')
    expect(run(joinParagraph, 'a\n\n# ‸b')).toBe('pass')
    expect(run(joinParagraph, 'a\n\nb‸c')).toBe('pass')
    expect(run(joinParagraph, 'a\n‸b')).toBe('pass')
  })
})

describe('formulas', () => {
  test('finds inline math but not prices or escaped dollars', () => {
    expect(findInlineMath('公式 $QK^T/\\sqrt{d}$ 呢').map((m) => m.tex)).toEqual(['QK^T/\\sqrt{d}'])
    expect(findInlineMath('costs $5 and $10')).toEqual([])
    expect(findInlineMath('$a$ and $b$').map((m) => m.tex)).toEqual(['a', 'b'])
    expect(findInlineMath('\\$x$ y')).toEqual([])
    expect(findInlineMath('$ x $')).toEqual([])
    expect(findInlineMath('$$x$$')).toEqual([])
  })
  test('finds display blocks on one line or several', () => {
    expect(findMathBlocks(['a', '$$ E = mc^2 $$', 'b'])).toEqual([{ first: 1, last: 1, tex: 'E = mc^2' }])
    expect(findMathBlocks(['$$', 'x', '= y', '$$'])).toEqual([{ first: 0, last: 3, tex: 'x\n= y' }])
    // 没写完的、被空行断开的不算
    expect(findMathBlocks(['$$', 'x'])).toEqual([])
    expect(findMathBlocks(['$$', 'x', '', '$$'])).toEqual([])
  })
})

describe('tables', () => {
  test('formats columns, counting Chinese characters as two wide', () => {
    expect(textWidth('模型')).toBe(4)
    const t = parseTable(['|模型|BLEU|', '|:-|-:|', '|Transformer|28.4|'])
    expect(t.align).toEqual(['left', 'right'])
    expect(formatTable(t)).toEqual([
      '| 模型        | BLEU |',
      '| :---------- | ---: |',
      '| Transformer | 28.4 |'
    ])
  })
  const doc = '| a | b |\n| --- | --- |\n| 1 | 2 |'
  test('Tab and Shift+Tab move between cells, adding a row at the end', () => {
    expect(run(nextCell, doc.replace('| a', '| a‸'))).toBe('| a   | ‸b   |\n| --- | --- |\n| 1   | 2   |')
    expect(run(nextCell, doc.replace('2 |', '2‸ |'))).toBe('| a   | b   |\n| --- | --- |\n| 1   | 2   |\n| ‸    |     |')
    expect(run(prevCell, doc.replace('| 1', '| 1‸'))).toBe('| a   | ‸b   |\n| --- | --- |\n| 1   | 2   |')
    expect(run(nextCell, 'not a table‸')).toBe('pass')
  })
  test('Enter goes to the next row and leaves the table on an empty last row', () => {
    expect(run(tableEnter, doc.replace('2 |', '2‸ |'))).toBe('| a   | b   |\n| --- | --- |\n| 1   | 2   |\n| ‸    |     |')
    expect(run(tableEnter, 'x\n\n' + doc + '\n| ‸ |  |')).toBe('x\n\n| a   | b   |\n| --- | --- |\n| 1   | 2   |\n\n‸')
  })
  test('Enter after a typed header row adds the separator and an empty row', () => {
    expect(run(tableEnter, '| 模型 | 分数 |‸')).toBe('| 模型 | 分数 |\n| ---- | ---- |\n| ‸     |      |')
    expect(run(tableEnter, 'not a table‸')).toBe('pass')
  })
})

describe('paste', () => {
  const md = (html: string) => htmlToMarkdown(parseHTML(`<html><body>${html}</body></html>`).document.body as never)
  test('turns web formatting into Markdown', () => {
    expect(md('<p>Some <b>bold</b> text with a <a href="https://x.org/a">link</a></p><ul><li>one</li><li>two<ul><li>deep</li></ul></li></ul>')).toBe(
      'Some **bold** text with a [link](https://x.org/a)\n\n- one\n- two\n  - deep'
    )
    expect(md('<h2>Results</h2><p>We use <code>torch</code> and <em>care</em>.</p>')).toBe('## Results\n\nWe use `torch` and *care*.')
    expect(md('<ol><li>a</li><li>b</li></ol>')).toBe('1. a\n2. b')
    expect(md('<blockquote><p>quoted</p></blockquote>')).toBe('> quoted')
    expect(md('<pre><code class="language-python">def f():\n    return 1\n</code></pre>')).toBe('```python\ndef f():\n    return 1\n```')
    expect(md('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>')).toBe('| A   | B   |\n| --- | --- |\n| 1   | 2   |')
    expect(md('<ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li></ul>')).toBe('- [x] done\n- [ ] todo')
  })
  test('handles Google Docs and styled spans', () => {
    expect(md('<b style="font-weight:normal" id="docs-internal-guid-1"><span style="font-weight:700">Key</span><span> point</span></b>')).toBe('**Key** point')
    expect(md('<span style="font-style:italic">slanted</span> text')).toBe('*slanted* text')
  })
  test('leaves plain or code-editor HTML to the plain-text paste', () => {
    expect(md('<p>just text</p>')).toBeNull()
    expect(md('<div style="font-family: Menlo, monospace; white-space: pre;"><div><span style="color:#f00">const</span> x = 1</div></div>')).toBeNull()
    expect(md('<a href="javascript:alert(1)">x</a>')).toBeNull()
  })
  test('escapes characters that would turn into Markdown', () => {
    expect(md('<p><b>a</b> 2*3*4 and [x]</p>')).toBe('**a** 2\\*3\\*4 and \\[x\\]')
  })
  test('joins lines broken by a PDF and its hyphenation', () => {
    const pdf = 'The dominant sequence transduction models are based on com-\nplex recurrent or convolutional neural networks that include an\nencoder and a decoder. The best performing models also connect\nthe encoder and decoder through an attention mechanism.'
    expect(unwrapPdfText(pdf)).toBe(
      'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. The best performing models also connect the encoder and decoder through an attention mechanism.'
    )
    expect(unwrapPdfText('注意力机制让模型在处理序列中的每个位置时都能直接看到所有其他位\n置，因此可以并行计算，训练速度比循环神经网络快得多，效果也更\n好。')).toBe('注意力机制让模型在处理序列中的每个位置时都能直接看到所有其他位置，因此可以并行计算，训练速度比循环神经网络快得多，效果也更好。')
    expect(unwrapPdfText('ﬁne-tuning works well for the downstream tasks that we tried here and\nthere are also some other results that we report in the appendix.')).toBe(
      'fine-tuning works well for the downstream tasks that we tried here and there are also some other results that we report in the appendix.'
    )
  })
  test('leaves short lines, lists and line-per-sentence text alone', () => {
    expect(unwrapPdfText('one\ntwo\nthree')).toBeNull()
    expect(unwrapPdfText('- first item that is fairly long to look like prose\n- second item that is also fairly long to look like prose')).toBeNull()
    expect(unwrapPdfText('This is a complete sentence that ends right here.\nThis is another complete sentence that ends here.\nAnd a third one that also ends.')).toBeNull()
    expect(unwrapPdfText('a single line of text with nothing else in it at all')).toBeNull()
  })
})

describe('title from the first heading', () => {
  test('reads the first heading without Markdown marks', () => {
    expect(headingTitle('# 读 Attention 的笔记\n\n正文')).toBe('读 Attention 的笔记')
    expect(headingTitle('\n\n## **Key** `idea` [[Transformer|T]] ##')).toBe('Key idea T')
    expect(headingTitle('正文\n# later')).toBeNull()
    expect(headingTitle('#hashtag')).toBeNull()
  })
  test('knows untitled names', () => {
    expect(isUntitledNote('未命名笔记')).toBe(true)
    expect(isUntitledNote('未命名笔记 3')).toBe(true)
    expect(isUntitledNote('未命名笔记的想法')).toBe(false)
  })
})
