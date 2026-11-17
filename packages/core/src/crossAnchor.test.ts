import { describe, expect, it } from 'vitest'
import { quoteAt } from './anchor'
import { locate } from './crossAnchor'

const pick = (text: string, part: string) => {
  const at = text.indexOf(part)
  return quoteAt(text, at, at + part.length)
}
const show = (text: string, r: ReturnType<typeof locate>) => r?.ranges.map(([s, e]) => text.slice(s, e))

describe('locate across renderings', () => {
  it('ignores line-break hyphens, ligatures, quotes and spacing', () => {
    const pdf = 'The deeper network has higher train-\ning error, and thus “ﬁnal” test error.\nNext'
    const html = 'The deeper network has higher training error, and thus "final" test error. Next'
    const r = locate(html, pick(pdf, 'higher train-\ning error, and thus “ﬁnal” test'))
    expect(r?.how).toBe('exact')
    expect(show(html, r)).toEqual(['higher training error, and thus "final" test'])
  })

  it('uses the context to pick the right one of several matches', () => {
    const pdf = 'first the model is trained on data. later the model is trained on data again'
    const html = 'first the model is trained on data. Later, the model is trained on data again'
    const r = locate(html, pick(pdf, 'the model is trained on data again'))
    expect(show(html, r)).toEqual(['the model is trained on data again'])
  })

  it('bridges a formula that renders differently', () => {
    const pdf = 'we minimize the loss L(θ) = Σi ℓ(xi) over all training examples in the batch'
    const html = 'we minimize the loss ℒ(𝜽)=∑iℓ(𝐱i) over all training examples in the batch'
    const r = locate(html, pick(pdf, 'minimize the loss L(θ) = Σi ℓ(xi) over all training examples'))
    expect(r?.how).toBe('fuzzy')
    expect(show(html, r)?.[0]).toMatch(/^minimize the loss .* over all training examples$/)
  })

  it('splits a PDF selection that runs across a figure caption into pieces', () => {
    const pdf = 'Residual learning makes very deep networks easy to optimize. Figure 2. A residual building block with an identity shortcut connection between layers. Our method also generalizes well to other recognition tasks'
    const html = 'Residual learning makes very deep networks easy to optimize. Our method also generalizes well to other recognition tasks. Figure 2: A residual building block with an identity shortcut connection between layers.'
    const r = locate(html, pick(pdf, 'makes very deep networks easy to optimize. Figure 2. A residual building block with an identity shortcut connection between layers. Our method also generalizes well'))
    expect(r?.ranges.length).toBeGreaterThanOrEqual(2)
    const pieces = show(html, r)!
    expect(pieces[0]).toBe('makes very deep networks easy to optimize. Our method also generalizes well')
    expect(pieces[1]).toMatch(/residual building block with an identity shortcut connection between layers/)
  })

  it('gives up on text that is not there', () => {
    expect(locate('completely unrelated words about cooking pasta', pick('axis labels 0 50 100 150 epoch', 'axis labels 0 50 100 150 epoch'))).toBeNull()
  })
})

describe('locate edges', () => {
  it('keeps punctuation at the ends of the selection', () => {
    const t = 'we use grouped-query attention (GQA) for speed'
    const r = locate(t, { exact: 'attention (GQA)', prefix: '', suffix: '' })!
    expect(t.slice(...r.ranges[0]!)).toBe('attention (GQA)')
    const r2 = locate(t, { exact: '(GQA', prefix: '', suffix: '' })!
    expect(t.slice(...r2.ranges[0]!)).toBe('(GQA')
  })
})
