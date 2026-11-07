import { describe, expect, it } from 'vitest'
import { NotAPdfError, readPdfFacts } from './pdf'
import { makePdf } from './testing/makePdf'

describe('readPdfFacts', () => {
  it('reads info, text and sized lines from the first pages', async () => {
    const pdf = makePdf(
      [
        [
          { text: 'arXiv:2101.01234v2 [cs.LG] 5 Jan 2021', size: 10, y: 400, x: 20 },
          { text: 'Learning to Sort Socks', size: 18, y: 700 },
          { text: 'Grace Hopper', size: 11, y: 660 },
          { text: 'Abstract. We sort socks.', size: 10, y: 600 }
        ],
        [{ text: 'Page two text', size: 10, y: 700 }],
        [{ text: 'Page three is not read', size: 10, y: 700 }]
      ],
      { title: 'Learning to Sort Socks', author: 'Grace Hopper' }
    )
    const f = await readPdfFacts(pdf, 'socks.pdf')
    expect(f.pageCount).toBe(3)
    expect(f.info).toEqual({ title: 'Learning to Sort Socks', author: 'Grace Hopper' })
    expect(f.text).toContain('arXiv:2101.01234v2 [cs.LG]')
    expect(f.text).toContain('Page two text')
    expect(f.text).not.toContain('Page three')
    expect(f.lines.find((l) => l.text === 'Learning to Sort Socks')).toMatchObject({ size: 18, y: 700 })
  })

  it('rejects files that are not PDFs', async () => {
    await expect(readPdfFacts(new TextEncoder().encode('hello'), 'fake.pdf')).rejects.toBeInstanceOf(NotAPdfError)
  })
})
