// 本地文件夹当同步后端：放在 Dropbox、OneDrive、iCloud 云盘这类同步盘里，就能在电脑之间同步。
// 写文件先写临时文件再改名，同步盘不会传上去半个文件。
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { SyncError, type Backend } from '@flax/core'

export function folderBackend(dir: string, folder = 'Flax'): Backend {
  const root = resolve(dir, folder)
  const at = (p: string) => {
    const full = resolve(root, p)
    if (full !== root && !full.startsWith(root + sep)) throw new Error('bad path')
    return full
  }
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOSPC') throw new SyncError('space', '同步文件夹所在的磁盘满了。')
      if (code === 'EACCES' || code === 'EPERM') throw new SyncError('auth', '没有权限写同步文件夹。')
      throw e
    }
  }
  return {
    list: (d) =>
      wrap(async () => {
        try {
          const items = await readdir(at(d), { withFileTypes: true })
          return items.filter((i) => !i.name.startsWith('.') && !i.name.endsWith('.tmp')).map((i) => (i.isDirectory() ? `${i.name}/` : i.name))
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw e
        }
      }),
    get: (p) =>
      wrap(async () => {
        try {
          return new Uint8Array(await readFile(at(p)))
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw e
        }
      }),
    put: (p, data) =>
      wrap(async () => {
        const full = at(p)
        await mkdir(dirname(full), { recursive: true })
        const tmp = `${full}.${process.pid}.tmp`
        await writeFile(tmp, data)
        await rename(tmp, full)
      }),
    del: (p) => wrap(() => rm(at(p), { force: true }))
  }
}

