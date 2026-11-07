import { expect, test } from 'vitest'
import { linkAt } from './noteLinks'

const line = '见 [[注意力机制|这里]]，原文 [第 3 页](paper://annotation/abc-123) 和 https://arxiv.org/abs/1706.03762 。'
test('wiki link', () => {
  expect(linkAt(line, line.indexOf('注意'))).toEqual({ kind: 'note', target: '注意力机制' })
})
test('annotation link', () => {
  expect(linkAt(line, line.indexOf('第 3'))).toEqual({ kind: 'annotation', target: 'abc-123' })
})
test('bare url', () => {
  expect(linkAt(line, line.indexOf('arxiv'))).toEqual({ kind: 'web', target: 'https://arxiv.org/abs/1706.03762' })
})
test('plain text is not a link', () => {
  expect(linkAt(line, 0)).toBeNull()
})
