// 同步文件的加密和压缩，必须和桌面（apps/desktop/src/main/syncCodec.ts）逐字节兼容：
// PBKDF2-HMAC-SHA256（密码先 NFC）、AES-256-GCM（IV 12 + 密文 + tag 16，无 AAD）、gzip。
// 600000 次 PBKDF2 用纯 JS 要几十秒，所以用 quick-crypto 的原生实现。
import QuickCrypto from 'react-native-quick-crypto'
import { gunzipSync, gzipSync } from 'fflate'
import type { Codec } from '@flax/core'

const bytes = (b: ArrayBufferView | ArrayBuffer): Uint8Array => (b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength))

function concat(...parts: (ArrayBufferView | ArrayBuffer)[]): Uint8Array {
  const bs = parts.map(bytes)
  const out = new Uint8Array(bs.reduce((n, b) => n + b.length, 0))
  let at = 0
  for (const b of bs) {
    out.set(b, at)
    at += b.length
  }
  return out
}

export const rnCodec: Codec = {
  deriveKey: (password, salt, iterations) =>
    new Promise((ok, fail) =>
      QuickCrypto.pbkdf2(password.normalize('NFC'), salt, iterations, 32, 'sha256', (e, k) => (e || !k ? fail(e ?? new Error('pbkdf2')) : ok(new Uint8Array(bytes(k)))))
    ),
  async encrypt(key, plain) {
    const iv = QuickCrypto.randomBytes(12)
    const c = QuickCrypto.createCipheriv('aes-256-gcm', key, iv)
    return concat(iv, c.update(plain), c.final(), c.getAuthTag())
  },
  async decrypt(key, data) {
    if (data.length < 28) throw new Error('too short')
    const d = QuickCrypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
    d.setAuthTag(QuickCrypto.Buffer.from(data.subarray(data.length - 16)))
    return concat(d.update(data.subarray(12, data.length - 16)), d.final())
  },
  gzip: async (b) => gzipSync(b),
  gunzip: async (b) => gunzipSync(b),
  random: (n) => new Uint8Array(bytes(QuickCrypto.randomBytes(n)))
}
