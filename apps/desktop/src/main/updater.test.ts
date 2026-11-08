import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false } }))
const { Updater, notesText } = await import('./updater')
import type { UpdateState } from '../shared/api'
import type { UpdaterLike } from './updater'

function fake() {
  const e = new EventEmitter() as EventEmitter & { autoDownload: boolean; autoInstallOnAppQuit: boolean; checkForUpdates: () => Promise<unknown>; downloadUpdate: () => Promise<unknown>; quitAndInstall: () => void }
  e.checkForUpdates = vi.fn(async () => {
    e.emit('checking-for-update')
    return null
  })
  e.downloadUpdate = vi.fn(async () => null)
  e.quitAndInstall = vi.fn()
  return e as unknown as typeof e & UpdaterLike
}

describe('Updater', () => {
  it('only tells about a new version; downloads and installs after the user says so', async () => {
    const u = fake()
    const seen: UpdateState[] = []
    const up = new Updater(u, (s) => seen.push(s))
    expect(u.autoDownload).toBe(false)
    up.check()
    await Promise.resolve()
    up.install()
    expect(u.downloadUpdate).not.toHaveBeenCalled()
    u.emit('update-available', { version: '0.2.0', releaseNotes: '<p>Flax 0.2.0</p><ul><li>新增 A</li><li>修复 B &amp; C</li></ul>' })
    expect(seen.at(-1)).toEqual({ kind: 'available', version: '0.2.0', notes: 'Flax 0.2.0\n- 新增 A\n- 修复 B & C', manual: false })
    expect(u.downloadUpdate).not.toHaveBeenCalled()
    // 再检查一次不会丢掉"有新版本"
    expect(up.check(true)).toMatchObject({ kind: 'available', manual: true })
    up.install()
    expect(u.downloadUpdate).toHaveBeenCalledOnce()
    u.emit('download-progress', { percent: 41.6 })
    expect(seen.at(-1)).toMatchObject({ kind: 'downloading', percent: 42 })
    expect(u.quitAndInstall).not.toHaveBeenCalled()
    u.emit('update-downloaded', { version: '0.2.0' })
    expect(seen.at(-1)).toMatchObject({ kind: 'ready', version: '0.2.0' })
    expect(u.quitAndInstall).toHaveBeenCalledOnce()
  })

  it('reports a failed download', async () => {
    const u = fake()
    u.downloadUpdate = vi.fn(async () => { throw new Error('net::ERR_CONNECTION_RESET') })
    const seen: UpdateState[] = []
    const up = new Updater(u, (s) => seen.push(s))
    u.emit('update-available', { version: '0.2.0' })
    up.install()
    await new Promise((r) => setTimeout(r, 0))
    expect(seen.at(-1)).toEqual({ kind: 'error', message: '连不上更新服务器，检查一下网络。', manual: true })
  })

  it('turns release notes into plain lines', () => {
    expect(notesText([{ note: '<p>a</p>' }, { note: null }])).toBe('a')
    expect(notesText(undefined)).toBe('')
  })

  it('marks manual checks and explains errors in plain words', async () => {
    const u = fake()
    const seen: UpdateState[] = []
    const up = new Updater(u, (s) => seen.push(s))
    up.check(true)
    u.emit('update-not-available')
    u.emit('error', new Error('HttpError: 404 Not Found'))
    expect(seen.at(-2)).toEqual({ kind: 'latest', manual: true })
    expect(seen.at(-1)).toEqual({ kind: 'error', message: '还没有发布过可以更新的版本。', manual: true })
  })

  it('does nothing in development', () => {
    const seen: UpdateState[] = []
    const up = new Updater(null, (s) => seen.push(s))
    expect(up.check(true)).toEqual({ kind: 'dev', manual: true })
  })
})
