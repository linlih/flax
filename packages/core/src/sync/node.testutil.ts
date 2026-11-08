// 测试用：Node 版的编码器和内存里的后端
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { Backend } from './backend'
import type { Codec } from './codec'

export const nodeCodec: Codec = {
  async deriveKey(password, salt, iterations) {
    return new Uint8Array(pbkdf2Sync(password, salt, Math.min(iterations, 1000), 32, 'sha256'))
  },
  async encrypt(key, plain) {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', key, iv)
    const body = Buffer.concat([c.update(plain), c.final()])
    return new Uint8Array(Buffer.concat([iv, body, c.getAuthTag()]))
  },
  async decrypt(key, data) {
    const iv = data.subarray(0, 12)
    const tag = data.subarray(data.length - 16)
    const d = createDecipheriv('aes-256-gcm', key, iv)
    d.setAuthTag(tag)
    return new Uint8Array(Buffer.concat([d.update(data.subarray(12, data.length - 16)), d.final()]))
  },
  async gzip(b) {
    return new Uint8Array(gzipSync(b))
  },
  async gunzip(b) {
    return new Uint8Array(gunzipSync(b))
  },
  random: (n) => new Uint8Array(randomBytes(n))
}

export function memoryBackend(): Backend & { files: Map<string, Uint8Array>; requests: number } {
  const files = new Map<string, Uint8Array>()
  const b = {
    files,
    requests: 0,
    async list(dir: string) {
      b.requests++
      const d = dir.replace(/^\/+/, '')
      const out = new Set<string>()
      for (const p of files.keys()) {
        if (!p.startsWith(d)) continue
        const rest = p.slice(d.length)
        const i = rest.indexOf('/')
        out.add(i < 0 ? rest : rest.slice(0, i + 1))
      }
      return out.size ? [...out] : null
    },
    async get(p: string) {
      b.requests++
      return files.get(p) ?? null
    },
    async put(p: string, data: Uint8Array) {
      b.requests++
      files.set(p, data)
    },
    async del(p: string) {
      b.requests++
      files.delete(p)
    }
  }
  return b
}

/** 测试用的最小 WebDAV 服务器：PROPFIND（Depth 1）、GET、PUT、DELETE、MKCOL，带 Basic 认证。
 *  上级目录不存在时 PUT 返回 409，和坚果云一样 */
export async function webdavServer(user = 'u', pass = 'p'): Promise<{ url: string; files: Map<string, Uint8Array>; dirs: Set<string>; close(): Promise<void>; log: string[] }> {
  const { createServer } = await import('node:http')
  const files = new Map<string, Uint8Array>()
  const dirs = new Set<string>(['/dav/'])
  const log: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
      log.push(`${req.method} ${path}`)
      if (req.headers.authorization !== 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')) return void res.writeHead(401).end()
      const parent = path.replace(/\/$/, '').replace(/[^/]+$/, '')
      switch (req.method) {
        case 'MKCOL':
          if (dirs.has(path.replace(/\/?$/, '/'))) return void res.writeHead(405).end()
          if (!dirs.has(parent)) return void res.writeHead(409).end()
          dirs.add(path.replace(/\/?$/, '/'))
          return void res.writeHead(201).end()
        case 'PUT':
          if (!dirs.has(parent)) return void res.writeHead(409).end()
          files.set(path, new Uint8Array(Buffer.concat(chunks)))
          return void res.writeHead(201).end()
        case 'GET': {
          const f = files.get(path)
          return void (f ? res.writeHead(200).end(Buffer.from(f)) : res.writeHead(404).end())
        }
        case 'DELETE':
          files.delete(path)
          return void res.writeHead(204).end()
        case 'PROPFIND': {
          const dir = path.replace(/\/?$/, '/')
          if (!dirs.has(dir)) return void res.writeHead(404).end()
          const kids = new Set<string>()
          for (const d of dirs) if (d !== dir && d.startsWith(dir) && !d.slice(dir.length, -1).includes('/')) kids.add(d)
          for (const f of files.keys()) if (f.startsWith(dir) && !f.slice(dir.length).includes('/')) kids.add(f)
          const entry = (href: string, isDir: boolean) => `<d:response><d:href>${encodeURI(href)}</d:href><d:propstat><d:prop><d:resourcetype>${isDir ? '<d:collection/>' : ''}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
          const body = `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${entry(dir, true)}${[...kids].map((k) => entry(k, k.endsWith('/'))).join('')}</d:multistatus>`
          return void res.writeHead(207, { 'Content-Type': 'application/xml' }).end(body)
        }
        default:
          return void res.writeHead(405).end()
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}/dav/`, files, dirs, log, close: () => new Promise((r) => server.close(() => r())) }
}
