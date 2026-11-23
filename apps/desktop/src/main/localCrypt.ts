// macOS 上 API Key 和同步密码不再用钥匙串（safeStorage）加密，改用存在本机的一把密钥。
//
// 为什么：Flax 用自己的证书签名，没有苹果的 Team ID。没有 Team ID 的应用建的钥匙串项目只认
// 这一次编译出来的程序（cdhash），每次更新都是"另一个程序"，都要输电脑密码，点"始终允许"也只管这一版。
//
// 密钥放在应用自己的数据目录（userData），不在资料文件夹里，资料文件夹同步到别处也带不走它；
// 文件只有当前用户能读。以前用钥匙串加密的文件，第一次读时用钥匙串解开（最后问一次密码），换成新的加密再写回去。
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Crypt {
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
  /** 旧格式（钥匙串加密）的数据：解开后换成新格式返回，调用方写回文件；已经是新格式返回 null。解不开就抛错 */
  refresh?(data: Buffer): Buffer | null
}

const MAGIC = Buffer.from('FXK1')
const IV = 12
const TAG = 16

/** keyFile：密钥文件；legacy：以前的钥匙串加密，只用来解开旧数据 */
export function createLocalCrypt(keyFile: string, legacy: Pick<Crypt, 'decrypt'>): Crypt {
  let key: Buffer | null = null
  const getKey = (): Buffer => {
    if (key) return key
    try {
      key = readFileSync(keyFile)
    } catch {
      mkdirSync(dirname(keyFile), { recursive: true })
      try {
        writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' })
      } catch {
        /* 另一个进程刚建好：下面读它的 */
      }
      key = readFileSync(keyFile)
    }
    if (key.length !== 32) {
      key = null
      throw new Error('本机密钥文件坏了')
    }
    return key
  }
  const isNew = (data: Buffer) => data.length >= MAGIC.length + IV + TAG && data.subarray(0, MAGIC.length).equals(MAGIC)
  const encrypt = (text: string): Buffer => {
    const iv = randomBytes(IV)
    const c = createCipheriv('aes-256-gcm', getKey(), iv)
    const body = Buffer.concat([c.update(text, 'utf8'), c.final()])
    return Buffer.concat([MAGIC, iv, c.getAuthTag(), body])
  }
  return {
    available: () => true,
    encrypt,
    decrypt(data) {
      if (!isNew(data)) return legacy.decrypt(data)
      const iv = data.subarray(MAGIC.length, MAGIC.length + IV)
      const tag = data.subarray(MAGIC.length + IV, MAGIC.length + IV + TAG)
      const d = createDecipheriv('aes-256-gcm', getKey(), iv)
      d.setAuthTag(tag)
      return Buffer.concat([d.update(data.subarray(MAGIC.length + IV + TAG)), d.final()]).toString('utf8')
    },
    refresh: (data) => (isNew(data) ? null : encrypt(legacy.decrypt(data)))
  }
}
