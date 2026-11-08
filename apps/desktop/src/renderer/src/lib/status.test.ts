import { describe, expect, it } from 'vitest'
import type { Paper } from '@flax/core'
import { isNew, isStale, nearEnd, progress, sortReading } from './status'

const now = Date.parse('2026-11-08T12:00:00Z')
const paper = (o: Partial<Paper>): Paper => ({
  id: 'p', updatedAt: '', deviceId: 'd', title: 't', authors: [], identifiers: {}, files: [], folderIds: [], tags: [],
  readingStatus: 'inbox', addedAt: '2026-11-01T00:00:00Z', metadataSource: 'user', needsMatch: false, ...o
})

describe('reading status display', () => {
  it('marks only papers added one by one as new', () => {
    expect(isNew(paper({}))).toBe(true)
    expect(isNew(paper({ batch: true }))).toBe(false)
    expect(isNew(paper({ readingStatus: 'to_read' }))).toBe(false)
  })

  it('reads progress from the saved position and the file page count', () => {
    const file = { hash: 'h', size: 1, mime: 'application/pdf' as const, pageCount: 15, role: 'main' as const, addedAt: '' }
    expect(progress(paper({ files: [file] }))).toBeNull()
    expect(progress(paper({ files: [file], readingPosition: { fileHash: 'h', page: 6, left: 0, top: 0, scale: 'auto', updatedAt: '' } }))).toEqual({ page: 6, total: 15 })
  })

  it('sorts recent papers first and stale ones last', () => {
    const a = paper({ id: 'a', lastOpenedAt: '2026-11-07T00:00:00Z' })
    const b = paper({ id: 'b', lastOpenedAt: '2026-11-08T00:00:00Z' })
    const old = paper({ id: 'old', lastOpenedAt: '2026-09-01T00:00:00Z' })
    expect(isStale(old, now)).toBe(true)
    expect(sortReading([old, a, b], now).map((p) => p.id)).toEqual(['b', 'a', 'old'])
  })

  it('treats the last two pages as the end', () => {
    expect(nearEnd(14, 15)).toBe(true)
    expect(nearEnd(13, 15)).toBe(false)
    expect(nearEnd(1, 1)).toBe(false)
    expect(nearEnd(2, 2)).toBe(false)
  })
})
