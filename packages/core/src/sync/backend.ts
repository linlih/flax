// 同步后端只需要四个操作：列目录、读、写、删。WebDAV（坚果云、Nextcloud、NAS）、本地文件夹、S3 都能做到。
// 路径都是相对同步根目录的，用 / 分隔；目录名以 / 结尾。

export interface Backend {
  /** 目录里的名字（子目录以 / 结尾）；目录不存在返回 null */
  list(dir: string): Promise<string[] | null>
  /** 文件不存在返回 null */
  get(path: string): Promise<Uint8Array | null>
  /** 写文件，上级目录不存在时建好 */
  put(path: string, data: Uint8Array): Promise<void>
  /** 删文件；本来就没有也不算错 */
  del(path: string): Promise<void>
}

export type SyncErrorCode = 'auth' | 'network' | 'timeout' | 'rate_limited' | 'server' | 'space' | 'wrong_key' | 'format' | 'not_found'

export class SyncError extends Error {
  constructor(readonly code: SyncErrorCode, message: string) {
    super(message)
  }
}

/** 和 fetch 一样的形状，只用到这些 */
export type HttpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Uint8Array; signal?: unknown }
) => Promise<{ status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>

export interface WebDavOptions {
  /** 例如 https://dav.jianguoyun.com/dav/ */
  url: string
  username: string
  password: string
  /** 在服务器上放哪个文件夹里，默认 Flax */
  folder?: string
  fetch: HttpFetch
  /** 每个请求的超时（毫秒） */
  timeoutMs?: number
  timeout?: (ms: number) => unknown
}

declare const TextEncoder: { new (): { encode(s: string): Uint8Array } }
declare const URL: { new (url: string, base?: string): { pathname: string } }

function basic(user: string, pass: string): string {
  const b = new TextEncoder().encode(`${user}:${pass}`)
  let s = ''
  for (const c of b) s += String.fromCharCode(c)
  return 'Basic ' + (globalThis as unknown as { btoa(s: string): string }).btoa(s)
}

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/')

export function webdav(o: WebDavOptions): Backend {
  const base = o.url.replace(/\/*$/, '/') + encodePath((o.folder ?? 'Flax').replace(/^\/+|\/+$/g, '')) + '/'
  const auth = basic(o.username, o.password)
  const made = new Set<string>()

  const baseTimeout = o.timeoutMs ?? 60_000
  /** 传大文件要的时间和大小成正比：在基本的超时上，按最慢 50 KB/s 再加（50 MB 的 PDF 大约 17 分钟） */
  const forBytes = (n: number) => baseTimeout + Math.ceil(n / 50)
  /** 下载 PDF 时不知道多大，给足 20 分钟 */
  const FILE_GET_MS = 20 * 60_000

  const req = async (method: string, path: string, extra: { headers?: Record<string, string>; body?: Uint8Array; timeoutMs?: number } = {}) => {
    let r: Awaited<ReturnType<HttpFetch>>
    try {
      r = await o.fetch(base + encodePath(path), {
        method,
        headers: { Authorization: auth, ...(extra.headers ?? {}) },
        ...(extra.body ? { body: extra.body } : {}),
        ...(o.timeout ? { signal: o.timeout(extra.timeoutMs ?? baseTimeout) } : {})
      })
    } catch (e) {
      if ((e as { name?: string } | null)?.name === 'TimeoutError') throw new SyncError('timeout', '同步服务器太久没有回应，稍后会自动再试。')
      throw new SyncError('network', `连不上同步服务器，请检查网络和服务器地址（${e instanceof Error ? e.message : String(e)}）`)
    }
    if (r.status === 401 || r.status === 403) throw new SyncError('auth', '同步服务器拒绝了账号或密码。坚果云要用“应用密码”，不是登录密码。')
    if (r.status === 429 || r.status === 503) throw new SyncError('rate_limited', '同步服务器说请求太频繁了，稍后会自动再试。')
    if (r.status === 507) throw new SyncError('space', '同步服务器的空间满了。')
    return r
  }
  const fail = (r: { status: number }, what: string): never => {
    throw new SyncError('server', `同步服务器出错（${what}：${r.status}）`)
  }

  const mkdirs = async (dir: string) => {
    const parts = dir.split('/').filter(Boolean)
    // 根目录（Flax/）本身也要建
    for (let i = 0; i <= parts.length; i++) {
      const d = parts.slice(0, i).join('/')
      const key = d + '/'
      if (made.has(key)) continue
      const r = await req('MKCOL', d ? d + '/' : '')
      // 201 建好了；405 已经有了；其他情况交给后面的 PUT 报错
      if (r.status === 201 || r.status === 405 || r.status === 301) made.add(key)
      else if (r.status === 409 && i === 0) fail(r, '建文件夹')
    }
  }

  return {
    async list(dir) {
      const d = dir.replace(/\/*$/, '/').replace(/^\/+/, '')
      const r = await req('PROPFIND', d === '/' ? '' : d, { headers: { Depth: '1', 'Content-Type': 'application/xml' }, body: new TextEncoder().encode('<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>') })
      if (r.status === 404) return null
      if (r.status !== 207) fail(r, '列目录')
      return parseMultistatus(await r.text(), base + encodePath(d === '/' ? '' : d))
    },
    async get(path) {
      const r = await req('GET', path, path.startsWith('files/') ? { timeoutMs: Math.max(baseTimeout, FILE_GET_MS) } : {})
      if (r.status === 404) return null
      if (r.status !== 200) fail(r, '下载')
      return new Uint8Array(await r.arrayBuffer())
    },
    async put(path, data) {
      const dir = path.slice(0, path.lastIndexOf('/') + 1)
      if (!made.has(dir)) await mkdirs(dir)
      let r = await req('PUT', path, { body: data, headers: { 'Content-Type': 'application/octet-stream' }, timeoutMs: forBytes(data.length) })
      if (r.status === 409 || r.status === 404) {
        // 文件夹可能被别人删了：重新建一次
        for (const k of [...made]) if (dir.startsWith(k)) made.delete(k)
        await mkdirs(dir)
        r = await req('PUT', path, { body: data, headers: { 'Content-Type': 'application/octet-stream' }, timeoutMs: forBytes(data.length) })
      }
      if (r.status < 200 || r.status >= 300) fail(r, '上传')
    },
    async del(path) {
      const r = await req('DELETE', path)
      if (r.status !== 404 && (r.status < 200 || r.status >= 300)) fail(r, '删除')
    }
  }
}

/** 从 PROPFIND 的结果里取出目录下的名字。不同服务器的命名空间前缀不一样（D:、d:、没有前缀），都认 */
export function parseMultistatus(xml: string, dirUrl: string): string[] {
  const dirPath = decodeURIComponent(new URL(dirUrl).pathname).replace(/\/*$/, '/')
  const out: string[] = []
  for (const block of xml.split(/<(?:[\w-]+:)?response[\s>]/i).slice(1)) {
    const href = /<(?:[\w-]+:)?href[^>]*>([^<]*)<\/(?:[\w-]+:)?href>/i.exec(block)?.[1]
    if (!href) continue
    let p: string
    try {
      p = decodeURIComponent(new URL(href.trim().replace(/&amp;/g, '&'), dirUrl).pathname)
    } catch {
      continue
    }
    const isDir = /<(?:[\w-]+:)?collection\s*\/?>/i.test(block)
    const norm = p.replace(/\/*$/, isDir ? '/' : '')
    if (norm.replace(/\/*$/, '/') === dirPath) continue
    if (!norm.startsWith(dirPath)) continue
    const name = norm.slice(dirPath.length).replace(/\/$/, '')
    if (!name || name.includes('/')) continue
    out.push(isDir ? name + '/' : name)
  }
  return out
}
