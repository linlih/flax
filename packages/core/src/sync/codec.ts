// 云端文件的封装：压缩、加密。具体算法由平台提供（桌面用 node:crypto 和 zlib），core 只定格式。
//
// 文件开头 4 个字节 "FLX1"，第 5 个字节是标志位：1 = 加密（AES-256-GCM，后面跟 12 字节 IV），2 = 压缩（gzip）。
// 加密时先压缩再加密。PDF 本身已经压缩过，只加密不压缩。

export interface Codec {
  /** 从同步密码派生 32 字节的库密钥（PBKDF2-SHA256） */
  deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array>
  /** AES-256-GCM；返回 IV(12) + 密文 + 校验(16) */
  encrypt(key: Uint8Array, plain: Uint8Array): Promise<Uint8Array>
  /** 密码不对或文件被改过时抛错 */
  decrypt(key: Uint8Array, data: Uint8Array): Promise<Uint8Array>
  gzip(data: Uint8Array): Promise<Uint8Array>
  gunzip(data: Uint8Array): Promise<Uint8Array>
  random(n: number): Uint8Array
}

declare const TextEncoder: { new (): { encode(s: string): Uint8Array } }
declare const TextDecoder: { new (): { decode(b: Uint8Array): string } }
declare function btoa(s: string): string
declare function atob(s: string): string

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b)

export function toBase64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const MAGIC = [0x46, 0x4c, 0x58, 0x31] // FLX1
const ENC = 1
const GZ = 2

export class WrongKeyError extends Error {
  constructor() {
    super('同步密码不对，或者云端的文件被改过')
  }
}

export async function seal(codec: Codec, key: Uint8Array | null, data: Uint8Array, compress: boolean): Promise<Uint8Array> {
  let body = compress ? await codec.gzip(data) : data
  if (key) body = await codec.encrypt(key, body)
  const out = new Uint8Array(5 + body.length)
  out.set(MAGIC)
  out[4] = (key ? ENC : 0) | (compress ? GZ : 0)
  out.set(body, 5)
  return out
}

export async function open(codec: Codec, key: Uint8Array | null, data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 5 || MAGIC.some((v, i) => data[i] !== v)) throw new Error('不是 Flax 的同步文件')
  const flags = data[4]!
  let body = data.subarray(5)
  if (flags & ENC) {
    if (!key) throw new WrongKeyError()
    try {
      body = await codec.decrypt(key, body)
    } catch {
      throw new WrongKeyError()
    }
  }
  return flags & GZ ? codec.gunzip(body) : body
}
