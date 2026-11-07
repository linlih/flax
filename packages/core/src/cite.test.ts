import { describe, expect, it } from 'vitest'
import { bibFiles, bibToPaper, citeKeys, formatCitation, latexToText, parseBibTeX, toBibTeX, toRIS } from './cite'

const attention = {
  title: 'Attention Is All You Need',
  authors: [{ given: 'Ashish', family: 'Vaswani' }, { given: 'Noam', family: 'Shazeer' }, { given: 'Niki', family: 'Parmar' }, { given: 'Jakob', family: 'Uszkoreit' }],
  year: 2017,
  venue: 'Advances in Neural Information Processing Systems',
  identifiers: { arxiv: '1706.03762', doi: '10.48550/arXiv.1706.03762' },
  tags: ['transformer']
}

describe('citations', () => {
  it('formats APA', () => {
    expect(formatCitation(attention, 'apa')).toBe('Vaswani, A., Shazeer, N., Parmar, N., & Uszkoreit, J. (2017). Attention Is All You Need. Advances in Neural Information Processing Systems. https://doi.org/10.48550/arXiv.1706.03762')
  })
  it('formats GB/T 7714 with et al after three authors', () => {
    expect(formatCitation(attention, 'gbt7714')).toBe('VASWANI A, SHAZEER N, PARMAR N, et al. Attention Is All You Need[J]. Advances in Neural Information Processing Systems, 2017. DOI: 10.48550/arXiv.1706.03762.')
  })
  it('formats an arXiv-only preprint and Chinese names', () => {
    const p = { title: '注意力机制综述', authors: [{ family: '张', given: '三' }], year: 2024, identifiers: { arxiv: '2401.01234' } }
    expect(formatCitation(p, 'gbt7714')).toBe('张三. 注意力机制综述[EB/OL]. arXiv:2401.01234, 2024. https://arxiv.org/abs/2401.01234.')
  })
  it('makes unique cite keys', () => {
    expect(citeKeys([attention, attention, { ...attention, authors: [{ family: 'Müller' }] }])).toEqual(['vaswani2017attention', 'vaswani2017attentiona', 'muller2017attention'])
  })
})

describe('export', () => {
  it('writes BibTeX that reads back the same', () => {
    const bib = toBibTeX([{ ...attention, title: 'Costs & Benefits of {Braces}_x' }])
    expect(bib).toContain('@article{vaswani2017costs,')
    expect(bib).toContain('author = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob}')
    const back = bibToPaper(parseBibTeX(bib)[0]!)!
    expect(back.meta.title).toBe('Costs & Benefits of Braces_x')
    expect(back.meta.authors[0]).toEqual({ given: 'Ashish', family: 'Vaswani' })
    expect(back.meta.identifiers.arxiv).toBe('1706.03762')
    expect(back.tags).toEqual(['transformer'])
  })
  it('writes RIS', () => {
    const ris = toRIS([attention])
    expect(ris.split('\n').slice(0, 4)).toEqual(['TY  - JOUR', 'TI  - Attention Is All You Need', 'AU  - Vaswani, Ashish', 'AU  - Shazeer, Noam'])
    expect(ris.trim().endsWith('ER  -')).toBe(true)
  })
})

describe('BibTeX import', () => {
  const zotero = `
@comment{jabref-meta: x}
@string{neurips = "Neural Information Processing Systems"}
@inproceedings{vaswani_attention_2017,
	title = {Attention is {All} you {Need}},
	booktitle = "Advances in " # neurips,
	author = {Vaswani, Ashish and Shazeer, Noam and {Google Brain Team} and others},
	year = {2017},
	keywords = {Computer Science - Machine Learning, transformer},
	file = {arXiv Fulltext PDF:/Users/me/Zotero/storage/ABCD1234/Vaswani 2017.pdf:application/pdf;Snapshot:/Users/me/Zotero/storage/ABCD1234/1706.html:text/html},
	eprint = {1706.03762v7},
	archivePrefix = {arXiv},
	note = {nested {braces {deep}} ok}
}
@article{bad
@article{schr, author = {Erwin Schr{\\"o}dinger and J{\\'e}r{\\^o}me L. Nguyen}, title = {Quanten--mechanik \\& {M}ore}, journal = {Ann. Phys.}, year = 1926, doi = {https://doi.org/10.1002/andp.19263840602}}
`
  it('reads Zotero exports with strings, files and LaTeX', () => {
    const entries = parseBibTeX(zotero)
    const keys = entries.map((e) => e.key)
    expect(keys).toContain('vaswani_attention_2017')
    expect(keys).toContain('schr')
    const a = bibToPaper(entries.find((e) => e.key === 'vaswani_attention_2017')!)!
    expect(a.meta.title).toBe('Attention is All you Need')
    expect(a.meta.venue).toBe('Advances in Neural Information Processing Systems')
    expect(a.meta.authors).toEqual([{ family: 'Vaswani', given: 'Ashish' }, { family: 'Shazeer', given: 'Noam' }, { family: 'Google Brain Team' }])
    expect(a.meta.identifiers.arxiv).toBe('1706.03762')
    expect(a.files).toEqual(['/Users/me/Zotero/storage/ABCD1234/Vaswani 2017.pdf'])
    expect(a.tags).toEqual(['Computer Science - Machine Learning', 'transformer'])
    const s = bibToPaper(entries.find((e) => e.key === 'schr')!)!
    expect(s.meta.authors).toEqual([{ given: 'Erwin', family: 'Schrödinger' }, { given: 'Jérôme L.', family: 'Nguyen' }])
    expect(s.meta.title).toBe('Quanten–mechanik & More')
    expect(s.meta.year).toBe(1926)
    expect(s.meta.identifiers.doi).toBe('10.1002/andp.19263840602')
  })
  it('handles plain file paths and LaTeX odds', () => {
    expect(bibFiles('/a/b c.pdf')).toEqual(['/a/b c.pdf'])
    expect(bibFiles('C\\:\\\\x\\\\y.pdf')).toEqual(['C:\\x\\y.pdf'])
    expect(latexToText('\\emph{Deep} {\\ss}trasse ~--- \\c{c}a')).toBe('Deep ßtrasse — ça')
  })
})
