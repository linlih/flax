import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { NoteStore } from './notes'

let dir: string
let n = 0
const make = () => new NoteStore(dir, { uuid: () => `id-${++n}`, now: () => '2026-11-06T00:00:00.000Z', trash: async (p) => rmSync(p) })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'notes-'))
  n = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('a note is a markdown file named after its title', () => {
  const s = make()
  const note = s.create({ title: 'Attention: notes', paperId: 'p1', body: '## 问题\n' })
  expect(note.title).toBe('Attention notes')
  const text = readFileSync(join(dir, 'Attention notes.md'), 'utf8')
  expect(text).toBe('---\nid: id-1\npaper: p1\ncreated: 2026-11-06T00:00:00.000Z\n---\n## 问题\n')
  expect(make().read('id-1')?.body).toBe('## 问题\n')
})

test('duplicate titles get a number', () => {
  const s = make()
  s.create({ title: 'Idea' })
  expect(s.create({ title: 'idea' }).title).toBe('idea 2')
})

test('saving keeps the head and updates links', () => {
  const s = make()
  const a = s.create({ title: 'A' })
  const saved = s.save(a.id, 'see [[B]]')
  expect(saved.links).toEqual(['B'])
  expect(readFileSync(join(dir, 'A.md'), 'utf8')).toContain('id: id-1')
})

test('renaming moves the file and fixes links in other notes', () => {
  const s = make()
  const a = s.create({ title: 'Old name' })
  const b = s.create({ title: 'B', body: 'link [[Old name]] and [[Old name|alias]] and [[Old name#方法]] and [[Old names]]' })
  s.rename(a.id, 'New name')
  expect(existsSync(join(dir, 'Old name.md'))).toBe(false)
  expect(existsSync(join(dir, 'New name.md'))).toBe(true)
  expect(s.read(b.id)?.body).toBe('link [[New name]] and [[New name|alias]] and [[New name#方法]] and [[Old names]]')
})

test('files written by other editors are picked up, and get a head on first save', () => {
  writeFileSync(join(dir, 'From Obsidian.md'), '# Hello\n\nplain text')
  const s = make()
  const [note] = s.list()
  expect(note?.title).toBe('From Obsidian')
  expect(note?.excerpt).toBe('plain text')
  const saved = s.save(note!.id, '# Hello\n\nedited')
  expect(saved.id).toBe('id-1')
  expect(readFileSync(join(dir, 'From Obsidian.md'), 'utf8')).toMatch(/^---\nid: id-1\n/)
})

test('remove sends the file to trash', async () => {
  const s = make()
  const a = s.create({ title: 'Gone' })
  await s.remove(a.id)
  expect(existsSync(join(dir, 'Gone.md'))).toBe(false)
  expect(s.list()).toEqual([])
})
