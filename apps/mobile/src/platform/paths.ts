// 资料文件夹：文档目录/Flax/Library，里面的结构和桌面一样（files/ab/<哈希>.pdf、notes/*.md）。
import { Directory, Paths } from 'expo-file-system'

export const libraryDir = new Directory(Paths.document, 'Flax', 'Library')
export const filesDir = new Directory(libraryDir, 'files')
export const notesDir = new Directory(libraryDir, 'notes')
export const aiDir = new Directory(libraryDir, 'ai')
export const syncDir = new Directory(libraryDir, 'sync')

export function ensureDirs(): void {
  for (const d of [libraryDir, filesDir, notesDir, aiDir, syncDir]) if (!d.exists) d.create({ intermediates: true, idempotent: true })
}

/** file:// 开头的 URI 去掉协议，给 expo-sqlite 当目录 */
export function plainPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, '')).replace(/\/$/, '')
}
