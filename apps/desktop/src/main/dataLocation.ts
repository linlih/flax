// 资料文件夹放在哪：默认在系统的应用数据目录里，用户可以在设置里换到别处（比如另一块硬盘）。
// 换过的位置记在一个固定的小文件里（不能记在资料文件夹自己里面），启动时先读它。
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
