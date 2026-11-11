// 按 SHA-256 存 PDF：files/ab/<哈希>.pdf，和桌面一样。同一个文件只存一份。
import { Directory, File } from 'expo-file-system'
import { filesDir } from './paths'
import { sha256 } from './hash'

const HASH = /^[0-9a-f]{64}$/

export function pdfFile(hash: string): File {
  if (!HASH.test(hash)) throw new Error('bad hash')
  return new File(filesDir, hash.slice(0, 2), `${hash}.pdf`)
}

export function hasPdf(hash: string): boolean {
  return pdfFile(hash).exists
}

export async function putPdf(data: Uint8Array, hash = sha256(data)): Promise<string> {
  const dest = pdfFile(hash)
  if (dest.exists) return hash
  const dir = new Directory(filesDir, hash.slice(0, 2))
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true })
  // 先写临时文件再改名，中途退出也不会留下半个文件
  const tmp = new File(dir, `${hash}.pdf.tmp`)
  if (tmp.exists) tmp.delete()
  tmp.create()
  tmp.writeSync(data)
  tmp.moveSync(dest)
  return hash
}

export async function readPdf(hash: string): Promise<Uint8Array> {
  return pdfFile(hash).bytes()
}
