// 按 SHA-256 存 PDF：files/ab/abcdef….pdf。同一个文件只存一份。
import { createHash } from 'node:crypto'
import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export class FileStore {
  constructor(readonly root: string) {}

  pathFor(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('bad hash')
    return join(this.root, 'files', hash.slice(0, 2), `${hash}.pdf`)
  }

  async put(data: Uint8Array, hash = sha256(data)): Promise<string> {
    const dest = this.pathFor(hash)
    if (await exists(dest)) return hash
    await mkdir(dirname(dest), { recursive: true })
    // 先写临时文件再改名，中途退出也不会留下半个文件
    const tmp = `${dest}.${process.pid}.tmp`
    await writeFile(tmp, data)
    await rename(tmp, dest)
    return hash
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}
