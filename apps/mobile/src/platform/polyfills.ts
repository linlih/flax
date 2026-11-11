// core 用到、React Native 上可能没有的全局接口。必须是应用最先 import 的文件（见 app/_layout.tsx）。
// quick-crypto 的 install() 补上 crypto.getRandomValues / randomUUID / subtle 和 Buffer。
import { install } from 'react-native-quick-crypto'

install()

const g = globalThis as Record<string, unknown>

// Hermes 自带 TextEncoder；TextDecoder 不一定有。core 只用 UTF-8
if (typeof g['TextDecoder'] === 'undefined') {
  class Utf8Decoder {
    readonly encoding = 'utf-8'
    decode(input?: ArrayBuffer | ArrayBufferView): string {
      if (!input) return ''
      const b = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      let out = ''
      let chunk: number[] = []
      for (let i = 0; i < b.length; ) {
        const c = b[i++]!
        let cp: number
        if (c < 0x80) cp = c
        else if (c >= 0xc0 && c < 0xe0) cp = ((c & 0x1f) << 6) | (b[i++]! & 0x3f)
        else if (c >= 0xe0 && c < 0xf0) cp = ((c & 0x0f) << 12) | ((b[i++]! & 0x3f) << 6) | (b[i++]! & 0x3f)
        else if (c >= 0xf0) cp = ((c & 0x07) << 18) | ((b[i++]! & 0x3f) << 12) | ((b[i++]! & 0x3f) << 6) | (b[i++]! & 0x3f)
        else cp = 0xfffd
        if (cp > 0xffff) {
          cp -= 0x10000
          chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
        } else chunk.push(cp)
        if (chunk.length > 8192) {
          out += String.fromCharCode(...chunk)
          chunk = []
        }
      }
      return out + String.fromCharCode(...chunk)
    }
  }
  g['TextDecoder'] = Utf8Decoder
}

// AbortSignal.timeout：WebDAV 每个请求的超时
const AS = g['AbortSignal'] as { timeout?: (ms: number) => AbortSignal } | undefined
if (AS && typeof AS.timeout !== 'function') {
  AS.timeout = (ms: number) => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), ms)
    return ac.signal
  }
}
