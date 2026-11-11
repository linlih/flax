// SHA-256（PDF 按哈希存）和机器翻译签名用的几个哈希。
import QuickCrypto from 'react-native-quick-crypto'
import type { MtCrypto } from '@flax/core/ai/runtime'

export function sha256(data: Uint8Array | string): string {
  return QuickCrypto.createHash('sha256').update(data).digest('hex') as string
}

export const mtCrypto: MtCrypto = {
  sha256Hex: (s) => sha256(s),
  md5Hex: (s) => QuickCrypto.createHash('md5').update(s).digest('hex') as string,
  hmacSha256: (key, s) => {
    const d = QuickCrypto.createHmac('sha256', key).update(s).digest() as unknown as Uint8Array
    return new Uint8Array(d)
  },
  randomHex: (n) => [...QuickCrypto.randomBytes(n)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
