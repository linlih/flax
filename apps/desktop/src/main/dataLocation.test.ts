import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyData, migrateLegacyDataDir, saveDataDir, savedDataDir, targetKind } from './dataLocation'

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

  it('moves the pre-rename Paper data into Flax/Library and leaves Electron caches behind', () => {
    const root = tmp()
    const legacy = join(root, 'Paper')
    const target = join(root, 'Flax', 'Library')
    mkdirSync(join(legacy, 'files', 'ab'), { recursive: true })
    mkdirSync(join(legacy, 'notes'))
    mkdirSync(join(legacy, 'ai', 'keys'), { recursive: true })
    mkdirSync(join(legacy, 'Cache'))
    writeFileSync(join(legacy, 'library.sqlite'), 'db')
    writeFileSync(join(legacy, 'files', 'ab', 'x.pdf'), 'pdf')
    writeFileSync(join(legacy, 'notes', 'a.md'), 'note')
    writeFileSync(join(legacy, 'ai', 'keys', 'k'), 'key')
    writeFileSync(join(legacy, 'prefs.json'), '{}')
    expect(migrateLegacyDataDir(legacy, target)).toBe(true)
    expect(readFileSync(join(target, 'library.sqlite'), 'utf8')).toBe('db')
    expect(readFileSync(join(target, 'files', 'ab', 'x.pdf'), 'utf8')).toBe('pdf')
    expect(readFileSync(join(target, 'notes', 'a.md'), 'utf8')).toBe('note')
    expect(readFileSync(join(target, 'ai', 'keys', 'k'), 'utf8')).toBe('key')
    expect(existsSync(join(target, 'prefs.json'))).toBe(true)
    expect(existsSync(join(legacy, 'library.sqlite'))).toBe(false)
    expect(existsSync(join(legacy, 'Cache'))).toBe(true)
    expect(existsSync(join(target, 'Cache'))).toBe(false)
    // 第二次启动什么都不做
    expect(migrateLegacyDataDir(legacy, target)).toBe(false)
  })

  it('leaves both folders alone when the new place already has a library', () => {
    const root = tmp()
    const legacy = join(root, 'Paper')
    const target = join(root, 'Flax', 'Library')
    mkdirSync(legacy)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(legacy, 'library.sqlite'), 'old')
    writeFileSync(join(target, 'library.sqlite'), 'new')
    expect(migrateLegacyDataDir(legacy, target)).toBe(false)
    expect(readFileSync(join(legacy, 'library.sqlite'), 'utf8')).toBe('old')
  })

  it('stops without touching the database when an item is already at the new place', () => {
    const root = tmp()
    const legacy = join(root, 'Paper')
    const target = join(root, 'Flax', 'Library')
    mkdirSync(join(legacy, 'notes'), { recursive: true })
    mkdirSync(join(target, 'notes'), { recursive: true })
    writeFileSync(join(legacy, 'library.sqlite'), 'db')
    expect(() => migrateLegacyDataDir(legacy, target)).toThrow(/notes/)
    expect(existsSync(join(legacy, 'library.sqlite'))).toBe(true)
  })
})
