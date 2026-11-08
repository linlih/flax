// 机器翻译挪到了 @flax/core（ai/mt.ts）。这里接上桌面的哈希（node:crypto）
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { machineTranslate as translate, type MtAccount, type MtCrypto, type MtRequest } from '@flax/core/ai/runtime'
import type { MtEngine } from '@flax/core'

export { toEnglish, type MtAccount } from '@flax/core/ai/runtime'

export const nodeMtCrypto: MtCrypto = {
  sha256Hex: (s) => createHash('sha256').update(s, 'utf8').digest('hex'),
  md5Hex: (s) => createHash('md5').update(s, 'utf8').digest('hex'),
  hmacSha256: (key, s) => new Uint8Array(createHmac('sha256', key).update(s, 'utf8').digest()),
  randomHex: (n) => randomBytes(n).toString('hex')
}

export function machineTranslate(engine: MtEngine, account: MtAccount, req: Omit<MtRequest, 'crypto'> & { crypto?: MtCrypto }): Promise<string> {
  return translate(engine, account, { crypto: nodeMtCrypto, ...req })
}
