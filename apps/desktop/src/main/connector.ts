// 浏览器插件连桌面端用的本地服务（设计见 docs/12-浏览器插件.md 第 4 节）。
// 只听 127.0.0.1。要防的是用户打开的恶意网页借浏览器调这些接口，做法照 Zotero：
//   1. Host 必须是本机名字（挡 DNS 重绑定）
//   2. 浏览器发来的请求必须带 X-Flax-Connector 头；网页要带自定义头得先过 CORS 预检，而预检我们一律不放行
//   3. 带 Origin 的话必须是插件的地址
// 本机别的程序不在防的范围内（它们本来就能直接读资料库）。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { PageInfo, PageResult } from '@flax/core'
import type { ConnectorState } from '../shared/api'

export type { ConnectorState } from '../shared/api'

export const CONNECTOR_PORT = 27183
/** 接口版本：插件在 X-Flax-Connector 头里带它支持的版本 */
export const CONNECTOR_API_VERSION = 1
/** 比这个旧的插件要先升级 */
const MIN_CLIENT_API = 1
const MAX_BODY = 1024 * 1024

const HOST_RE = /^(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d+)?$/i
const EXTENSION_ORIGIN_RE = /^(?:chrome-extension|moz-extension|safari-web-extension|extension):\/\/[\w.-]+$/

export interface ConnectorDeps {
  version: string
  findPage(page: PageInfo): PageResult | null
  addFromPage(page: PageInfo): Promise<(PageResult & { status: 'added' | 'existing' }) | null>
  /** 把窗口拉到前面并显示这篇 */
  open(paperId: string): boolean
  /** 存好了一篇（发系统通知用） */
  onSaved?(r: PageResult & { status: 'added' | 'existing' }): void
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export function createConnectorHandler(d: ConnectorDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Flax-Version': d.version })
    res.end(JSON.stringify(body))
  }
  const drop = (req: IncomingMessage) => req.socket.destroy()

  return (req, res) => {
    const h = req.headers
    if (!HOST_RE.test(h.host ?? '')) return drop(req)
    // 预检：不回 Access-Control-Allow-Origin，网页带不了自定义头
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'X-Flax-Version': d.version })
      return res.end()
    }
    const path = (req.url ?? '').split('?')[0]
    // 用户自己在地址栏打开，方便确认 Flax 开着
    if (req.method === 'GET' && path === '/ping' && h['sec-fetch-mode'] === 'navigate') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Flax-Version': d.version })
      return res.end('Flax 正在运行')
    }
    const fromBrowser = (h['user-agent'] ?? '').startsWith('Mozilla/') || 'origin' in h
    const clientApi = Number(h['x-flax-connector'])
    if (fromBrowser && !h['x-flax-connector']) return drop(req)
    if (h.origin && !EXTENSION_ORIGIN_RE.test(h.origin)) return send(res, 403, { error: 'forbidden' })
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' })
    if (!(h['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'json_only' })
    if (h['x-flax-connector'] && !(clientApi >= MIN_CLIENT_API)) return send(res, 412, { error: 'extension_too_old', apiVersion: CONNECTOR_API_VERSION })

    readJson(req)
      .then(async (body) => {
        switch (path) {
          case '/ping':
            return send(res, 200, { app: 'flax', version: d.version, apiVersion: CONNECTOR_API_VERSION })
          case '/lookup':
            return send(res, 200, { paper: d.findPage(asPage(body)) })
          case '/save': {
            const r = await d.addFromPage(asPage(body))
            if (!r) return send(res, 422, { error: 'no_paper' })
            d.onSaved?.(r)
            return send(res, 200, r)
          }
          case '/open': {
            const id = (body as { paperId?: unknown }).paperId
            if (typeof id !== 'string') throw new HttpError(400, 'paperId')
            return send(res, d.open(id) ? 200 : 404, { ok: true })
          }
          default:
            return send(res, 404, { error: 'not_found' })
        }
      })
      .catch((e: unknown) => {
        if (res.headersSent) return
        if (e instanceof HttpError) return send(res, e.status, { error: e.message })
        console.error('connector:', e)
        send(res, 500, { error: 'internal', message: e instanceof Error ? e.message : String(e) })
      })
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'too_large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        reject(new HttpError(400, 'bad_json'))
      }
    })
    req.on('error', reject)
  })
}

function asPage(body: unknown): PageInfo {
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b['url'] !== 'string') throw new HttpError(400, 'url')
  // 里面的字段在 core 里逐个检查
  return b as unknown as PageInfo
}

/** 开始监听；端口被占不算出错，报给设置页显示 */
export function startConnector(d: ConnectorDeps, port: number, onState: (s: ConnectorState) => void): { stop(): void } {
  const server: Server = createServer(createConnectorHandler(d))
  server.requestTimeout = 120_000
  server.on('error', (e: NodeJS.ErrnoException) => {
    onState(e.code === 'EADDRINUSE' ? { kind: 'port_in_use', port } : { kind: 'error', port, message: e.message })
  })
  server.listen(port, '127.0.0.1', () => onState({ kind: 'listening', port }))
  return {
    stop() {
      server.close()
      server.closeAllConnections()
      onState({ kind: 'off' })
    }
  }
}
