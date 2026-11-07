import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false } }))
const { Updater } = await import('./updater')
import type { UpdateState } from '../shared/api'
import type { UpdaterLike } from './updater'

function fake() {
  const e = new EventEmitter() as EventEmitter & { autoDownload: boolean; autoInstallOnAppQuit: boolean; checkForUpdates: () => Promise<unknown>; quitAndInstall: () => void }
  e.checkForUpdates = vi.fn(async () => {
    e.emit('checking-for-update')
    return null
  })
  e.quitAndInstall = vi.fn()
  return e as unknown as typeof e & UpdaterLike
}

describe('Updater', () => {
  it('downloads in the background and installs only when ready', async () => {
    const u = fake()
    const seen: UpdateState[] = []
    const up = new Updater(u, (s) => seen.push(s))
    expect(u.autoDownload && u.autoInstallOnAppQuit).toBe(true)
    up.check()
    await Promise.resolve()
    up.install()
    expect(u.quitAndInstall).not.toHaveBeenCalled()
    u.emit('update-available', { version: '0.2.0' })
    u.emit('download-progress', { percent: 41.6 })
    u.emit('update-downloaded', { version: '0.2.0' })
    expect(seen.map((s) => s.kind)).toEqual(['checking', 'downloading', 'downloading', 'ready'])
    expect(seen[2]).toMatchObject({ percent: 42, manual: false })
    up.install()
    expect(u.quitAndInstall).toHaveBeenCalledOnce()
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
