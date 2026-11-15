import { describe, expect, it } from 'vitest'
import { identifyPrompt, parseIdentified } from './identify'

describe('parseIdentified', () => {
  it('reads the JSON the model was asked for, even with text around it', () => {
    const answer = '好的：\n```json\n{"title": "深度学习", "authors": ["张三", "Grace Hopper"], "publisher": "示例出版社", "year": 2017, "isbn": "978-0-306-40615-7", "doi": null}\n```'
    expect(parseIdentified(answer)).toEqual({
      title: '深度学习',
      authors: [{ family: '张三' }, { given: 'Grace', family: 'Hopper' }],
      venue: '示例出版社',
      year: 2017,
      identifiers: { isbn: '9780306406157' },
      source: 'ai'
    })
  })
  it('drops an ISBN with a wrong check digit and a year that is not a year', () => {
    expect(parseIdentified('{"title": "A Field Guide", "authors": [], "publisher": null, "year": "n/a", "isbn": "978-0-306-40615-8", "doi": null}')).toEqual({ title: 'A Field Guide', authors: [], identifiers: {}, source: 'ai' })
  })
  it('gives nothing when there is no title or the answer is not JSON', () => {
    expect(parseIdentified('{"title": null, "authors": []}')).toBeNull()
    expect(parseIdentified('我看不清这几页。')).toBeNull()
  })
})

describe('identifyPrompt', () => {
  it('sends the text when there is some, and only points at the images otherwise', () => {
    expect(identifyPrompt({ text: ' Title page ' })).toContain('Title page')
    expect(identifyPrompt({ images: [{ mime: 'image/jpeg', base64: 'AAAA' }] })).toBe('上面是这份 PDF 前几页的图片。')
  })
})
