// 浏览器插件连桌面端用的本地服务（设计见 docs/12-浏览器插件.md 第 4 节）。
// 只听 127.0.0.1。要防的是用户打开的恶意网页借浏览器调这些接口，做法照 Zotero：
//   1. Host 必须是本机名字（挡 DNS 重绑定）
//   2. 浏览器发来的请求必须带 X-Flax-Connector 头；网页要带自定义头得先过 CORS 预检，而预检我们一律不放行
//   3. 带 Origin 的话必须是插件的地址
// 本机别的程序不在防的范围内（它们本来就能直接读资料库）。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { PageInfo, PageResult, SavedPatch, SaveTarget } from '@flax/core'
import type { ConnectorState } from '../shared/api'

export type { ConnectorState } from '../shared/api'

export const CONNECTOR_PORT = 27183
/** 接口版本：插件在 X-Flax-Connector 头里带它支持的版本 */
// 2：插件在网页里显示保存窗口，自己下 PDF 传过来（/file），选文件夹和标签（/targets、/update），找开放获取的 PDF（/findPdf）
export const CONNECTOR_API_VERSION = 2
/** 比这个旧的插件要先升级 */
const MIN_CLIENT_API = 1
const MAX_BODY = 1024 * 1024
/** 插件传来的 PDF，和粘贴链接下载的上限一样 */
const MAX_FILE = 200 * 1024 * 1024

const HOST_RE = /^(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d+)?$/i
const EXTENSION_ORIGIN_RE = /^(?:chrome-extension|moz-extension|safari-web-extension|extension):\/\/[\w.-]+$/

export interface ConnectorDeps {
  version: string
  findPage(page: PageInfo): PageResult | null
  addFromPage(page: PageInfo): Promise<(PageResult & { status: 'added' | 'existing' }) | null>
  /** 插件在浏览器里下好的 PDF；带 paperId 是配给刚存的那篇，不带是直接打开的 PDF 标签页 */
  addPdfData(data: Uint8Array, fileName: string, paperId?: string): Promise<PageResult & { status: 'added' | 'existing' }>
  /** 网页上没下到 PDF，Flax 自己找免费的版本 */
  findOpenPdf(paperId: string): Promise<PageResult>
  saveTargets(): { folders: SaveTarget[]; tags: string[] }
  updateSaved(paperId: string, patch: SavedPatch): PageResult
  /** 把窗口拉到前面并显示这篇 */
  open(paperId: string): boolean
  /** 存好了一篇（发系统通知用）。quiet：插件在网页里自己显示了结果，不用再发通知 */
  onSaved?(r: PageResult & { status: 'added' | 'existing' }, quiet: boolean): void
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
    if (h['x-flax-connector'] && !(clientApi >= MIN_CLIENT_API)) return send(res, 412, { error: 'extension_too_old', apiVersion: CONNECTOR_API_VERSION })
    const fail = (e: unknown) => {
      if (res.headersSent) return
      if (e instanceof HttpError) return send(res, e.status, { error: e.message })
      // 桌面端给用户看的原因（下载失败、不是 PDF……），插件窗口里直接显示
      send(res, 500, { error: 'failed', message: e instanceof Error ? e.message : String(e) })
    }

    // PDF 文件：请求体就是 PDF，参数放在网址里（和 Zotero 的 saveAttachment 一样）
    if (path === '/file') {
      if (!(h['content-type'] ?? '').startsWith('application/pdf')) return send(res, 415, { error: 'pdf_only' })
      const q = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
      const name = (q.get('name') ?? '').replace(/[\\/\0]/g, '').slice(0, 200) || 'paper.pdf'
      readBody(req, MAX_FILE)
        .then((data) => d.addPdfData(data, name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`, q.get('paperId') || undefined))
        .then((r) => {
          if (!q.get('paperId')) d.onSaved?.(r, q.get('quiet') === '1')
          send(res, 200, r)
        }, fail)
      return
    }
    if (!(h['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'json_only' })

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
            d.onSaved?.(r, (body as { quiet?: unknown }).quiet === true)
            return send(res, 200, r)
          }
          case '/findPdf':
            return send(res, 200, await d.findOpenPdf(paperId(body)))
          case '/targets':
            return send(res, 200, d.saveTargets())
          case '/update':
            return send(res, 200, d.updateSaved(paperId(body), (body as { patch?: unknown }).patch as SavedPatch ?? {}))
          case '/open':
            return send(res, d.open(paperId(body)) ? 200 : 404, { ok: true })
          default:
            return send(res, 404, { error: 'not_found' })
        }
      })
      .catch(fail)
  }
}

function readBody(req: IncomingMessage, max: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > max) {
        reject(new HttpError(413, 'too_large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))))
    req.on('error', reject)
  })
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const data = await readBody(req, MAX_BODY)
  try {
    return data.length ? JSON.parse(Buffer.from(data).toString('utf8')) : {}
  } catch {
    throw new HttpError(400, 'bad_json')
  }
}

function paperId(body: unknown): string {
  const id = (body as { paperId?: unknown } | null)?.paperId
  if (typeof id !== 'string' || !id) throw new HttpError(400, 'paperId')
  return id
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
