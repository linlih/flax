// 资料文件夹放在哪：默认在系统的应用数据目录里，用户可以在设置里换到别处（比如另一块硬盘）。
// 换过的位置记在一个固定的小文件里（不能记在资料文件夹自己里面），启动时先读它。
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

const FILE = 'data-location.json'

/** 记下来的位置；没换过（或记录读不懂）时是 null */
export function savedDataDir(configDir: string): string | null {
  try {
    const v = JSON.parse(readFileSync(join(configDir, FILE), 'utf8')) as { dataDir?: unknown }
    return typeof v.dataDir === 'string' && v.dataDir ? v.dataDir : null
  } catch {
    return null
  }
}

/** 记下新位置；换回默认位置时删掉记录 */
export function saveDataDir(configDir: string, dir: string, defaultDir: string): void {
  const file = join(configDir, FILE)
  if (same(dir, defaultDir)) return rmSync(file, { force: true })
  mkdirSync(configDir, { recursive: true })
  writeFileSync(file, JSON.stringify({ dataDir: dir }, null, 2) + '\n')
}

/** 选的文件夹是什么情况：
 *  same 就是现在用的；inside 在现在的资料文件夹里面；library 里面已经有一个 Flax 资料库；
 *  empty 空文件夹（可以把资料搬过去）；other 有别的东西（不往里面放，免得和别人的文件混在一起） */
export type TargetKind = 'same' | 'inside' | 'library' | 'empty' | 'other'

export function targetKind(current: string, target: string): TargetKind {
  const a = real(current)
  const b = real(target)
  if (a === b) return 'same'
  if (b.startsWith(a + sep)) return 'inside'
  if (existsSync(join(b, 'library.sqlite'))) return 'library'
  const entries = existsSync(b) ? readdirSync(b).filter((n) => !IGNORED.has(n)) : []
  return entries.length ? 'other' : 'empty'
}

/** 系统自己放的文件，不算"有东西" */
const IGNORED = new Set(['.DS_Store', 'desktop.ini', 'Thumbs.db', '.localized'])

/** 把整个资料文件夹拷到新位置（数据库要先关掉）。拷完检查一下数据库在不在 */
export async function copyData(from: string, to: string): Promise<void> {
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(from)) {
    if (IGNORED.has(name)) continue
    await cp(join(from, name), join(to, name), { recursive: true, errorOnExist: true, force: false })
  }
  if (!existsSync(join(to, 'library.sqlite'))) throw new Error('拷过去以后找不到数据库')
}

function real(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

function same(a: string, b: string): boolean {
  return real(a) === real(b)
}

/** 资料文件夹里属于 Flax 的几项。数据库的三个文件放在最后挪：中途出错时，旧位置还认得出是一个资料库，下次启动接着挪 */
const LEGACY_ITEMS = ['files', 'notes', 'ai', 'prefs.json', 'library.sqlite-wal', 'library.sqlite-shm', 'library.sqlite']

/** 改名前（0.1.4 及以前）资料在应用数据目录的 Paper 文件夹里，和 Electron 自己的缓存混在一起。
 *  现在默认位置是 Flax/Library：第一次启动时把属于资料的那几项挪过去（同一块盘上只是改名，瞬间完成），
 *  Paper 里剩下的缓存不管。新位置已经有资料库时什么都不动。返回挪了没有 */
export function migrateLegacyDataDir(legacy: string, target: string): boolean {
  if (!existsSync(join(legacy, 'library.sqlite')) || existsSync(join(target, 'library.sqlite'))) return false
  mkdirSync(target, { recursive: true })
  for (const name of LEGACY_ITEMS) {
    const from = join(legacy, name)
    const to = join(target, name)
    if (!existsSync(from)) continue
    if (existsSync(to)) throw new Error(`新的资料文件夹里已经有 ${name}，没有搬动：${target}`)
    renameSync(from, to)
  }
  return true
}
