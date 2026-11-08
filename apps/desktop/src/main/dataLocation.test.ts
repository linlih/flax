import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyData, saveDataDir, savedDataDir, targetKind } from './dataLocation'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'flax-loc-'))
  dirs.push(d)
  return d
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('data location', () => {
  it('remembers a chosen folder and forgets it when set back to the default', () => {
    const cfg = tmp()
    const def = join(tmp(), 'Paper')
    expect(savedDataDir(cfg)).toBeNull()
    saveDataDir(cfg, '/Volumes/Disk/Flax', def)
    expect(savedDataDir(cfg)).toBe('/Volumes/Disk/Flax')
    saveDataDir(cfg, def, def)
    expect(savedDataDir(cfg)).toBeNull()
  })

  it('ignores an unreadable record', () => {
    const cfg = tmp()
    writeFileSync(join(cfg, 'data-location.json'), '{oops')
    expect(savedDataDir(cfg)).toBeNull()
  })

  it('tells what kind of folder was picked', () => {
    const cur = tmp()
    writeFileSync(join(cur, 'library.sqlite'), '')
    expect(targetKind(cur, cur)).toBe('same')
    mkdirSync(join(cur, 'files'))
    expect(targetKind(cur, join(cur, 'files'))).toBe('inside')
    const empty = tmp()
    writeFileSync(join(empty, '.DS_Store'), '')
    expect(targetKind(cur, empty)).toBe('empty')
    expect(targetKind(cur, join(empty, 'new'))).toBe('empty')
    const other = tmp()
    writeFileSync(join(other, 'thesis.docx'), '')
    expect(targetKind(cur, other)).toBe('other')
    const lib = tmp()
    writeFileSync(join(lib, 'library.sqlite'), '')
    expect(targetKind(cur, lib)).toBe('library')
  })

  it('copies the whole folder', async () => {
    const from = tmp()
    writeFileSync(join(from, 'library.sqlite'), 'db')
    mkdirSync(join(from, 'files', 'ab'), { recursive: true })
    writeFileSync(join(from, 'files', 'ab', 'abc.pdf'), 'pdf')
    mkdirSync(join(from, 'notes'))
    writeFileSync(join(from, 'notes', 'a.md'), '# a')
    const to = join(tmp(), 'Flax')
    await copyData(from, to)
    expect(readFileSync(join(to, 'files', 'ab', 'abc.pdf'), 'utf8')).toBe('pdf')
    expect(readFileSync(join(to, 'notes', 'a.md'), 'utf8')).toBe('# a')
    expect(existsSync(join(from, 'library.sqlite'))).toBe(true)
  })

  it('fails when there is no database to copy', async () => {
    await expect(copyData(tmp(), join(tmp(), 'x'))).rejects.toThrow()
  })
})
