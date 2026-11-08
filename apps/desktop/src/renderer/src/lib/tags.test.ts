import { describe, expect, it } from 'vitest'
import { renameTag } from './tags'

describe('renameTag', () => {
  it('keeps the tag in place', () => expect(renameTag(['a', 'b', 'c'], 'b', ' 注意力 ')).toEqual(['a', '注意力', 'c']))
  it('removes the tag when emptied', () => expect(renameTag(['a', 'b'], 'a', '  ')).toEqual(['b']))
  it('merges into a tag the paper already has', () => expect(renameTag(['a', 'b'], 'a', 'b')).toEqual(['b']))
  it('drops a leading #', () => expect(renameTag(['a'], 'a', '#nlp')).toEqual(['nlp']))
  it('changes nothing when unchanged', () => {
    const tags = ['a']
    expect(renameTag(tags, 'a', 'a')).toBe(tags)
  })
})
