// 同步用的加密和压缩（core 的 Codec 接口的 Node 实现）。移动端用同样的算法另写一份。
import { createCipheriv, createDecipheriv, pbkdf2, randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'
import type { Codec } from '@flax/core'

const pbkdf2Async = promisify(pbkdf2)
const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

export const nodeCodec: Codec = {
  async deriveKey(password, salt, iterations) {
    return new Uint8Array(await pbkdf2Async(password.normalize('NFC'), salt, iterations, 32, 'sha256'))
  },
  async encrypt(key, plain) {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', key, iv)
    const body = Buffer.concat([c.update(plain), c.final()])
    return new Uint8Array(Buffer.concat([iv, body, c.getAuthTag()]))
  },
  async decrypt(key, data) {
    if (data.length < 28) throw new Error('too short')
    const d = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
    d.setAuthTag(data.subarray(data.length - 16))
    return new Uint8Array(Buffer.concat([d.update(data.subarray(12, data.length - 16)), d.final()]))
  },
  gzip: async (b) => new Uint8Array(await gzipAsync(b)),
  gunzip: async (b) => new Uint8Array(await gunzipAsync(b)),
  random: (n) => new Uint8Array(randomBytes(n))
}
