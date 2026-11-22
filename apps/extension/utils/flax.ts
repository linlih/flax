// 和桌面端的 Flax 说话（接口见 docs/12-浏览器插件.md 第 4.3 节）。
import type { PageInfo } from './extract'

export const DEFAULT_PORT = 27183
/** 插件支持的接口版本，放在 X-Flax-Connector 头里（不带这个头的请求桌面端直接断开） */
const API_VERSION = 1

export interface PaperRef {
  paperId: string
  title: string
  hasPdf: boolean
}
export interface Saved extends PaperRef {
  status: 'added' | 'existing'
}

/** offline：没开 Flax，或者端口上是别的程序；too_old：Flax 要求更新的插件；no_paper：桌面端认为页面上没有论文 */
export class FlaxError extends Error {
  constructor(readonly kind: 'offline' | 'too_old' | 'no_paper' | 'failed', message: string = kind) {
    super(message)
  }
}

export async function getPort(): Promise<number> {
  try {
    const { port } = await browser.storage.local.get('port')
    return Number.isInteger(port) && (port as number) >= 1024 && (port as number) <= 65535 ? (port as number) : DEFAULT_PORT
  } catch {
    return DEFAULT_PORT
  }
}

async function call<T>(path: string, body: unknown, timeoutMs = 5000): Promise<T> {
  const port = await getPort()
  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Flax-Connector': String(API_VERSION) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch {
    throw new FlaxError('offline')
  }
  // 不是 Flax 回的（端口上是别的程序）也当成没开
  if (!res.headers.get('X-Flax-Version')) throw new FlaxError('offline')
  if (res.status === 412) throw new FlaxError('too_old')
  if (res.status === 422) throw new FlaxError('no_paper')
  if (!res.ok) {
    const msg = await res.json().then((j: { message?: string; error?: string }) => j.message ?? j.error ?? '').catch(() => '')
    throw new FlaxError('failed', msg || `Flax 返回 ${res.status}`)
  }
  return (await res.json()) as T
}

export const flax = {
  ping: () => call<{ app: string; version: string; apiVersion: number }>('/ping', {}, 1500),
  lookup: (page: PageInfo) => call<{ paper: PaperRef | null }>('/lookup', page).then((r) => r.paper),
  // 联网查元数据可能要十几秒（arXiv 有限速）；直接打开的 PDF 要等 Flax 下完文件，大文件更久
  save: (page: PageInfo) => call<Saved>('/save', page, page.isPdf ? 115_000 : 60_000),
  open: (paperId: string) => call<{ ok: boolean }>('/open', { paperId })
}
