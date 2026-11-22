// 和桌面端的 Flax 说话（接口见 docs/12-浏览器插件.md 第 4.3 节和第 10 节）。
import type { PageInfo } from './extract'

export const DEFAULT_PORT = 27183
/** 插件支持的接口版本，放在 X-Flax-Connector 头里（不带这个头的请求桌面端直接断开） */
const API_VERSION = 2

export interface PaperRef {
  paperId: string
  title: string
  hasPdf: boolean
  /** 旧版 Flax（接口版本 1）没有这个字段 */
  pdf?: 'yes' | 'downloading' | 'no'
}
export interface Saved extends PaperRef {
  status: 'added' | 'existing'
}
export interface Folder {
  id: string
  name: string
  depth: number
}
export interface SavedPatch {
  addFolder?: string
  removeFolder?: string
  addTags?: string[]
  removeTags?: string[]
}

/** offline：没开 Flax，或者端口上是别的程序；too_old：Flax 要求更新的插件；no_paper：桌面端认为页面上没有论文；old_flax：Flax 太旧，没有这个接口 */
export class FlaxError extends Error {
  constructor(readonly kind: 'offline' | 'too_old' | 'no_paper' | 'old_flax' | 'failed', message: string = kind) {
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

async function call<T>(path: string, body: BodyInit, contentType: string, timeoutMs: number): Promise<T> {
  const port = await getPort()
  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'X-Flax-Connector': String(API_VERSION) },
      body,
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'TimeoutError') throw new FlaxError('failed', 'Flax 太久没有回应')
    throw new FlaxError('offline')
  }
  // 不是 Flax 回的（端口上是别的程序）也当成没开
  if (!res.headers.get('X-Flax-Version')) throw new FlaxError('offline')
  if (res.status === 412) throw new FlaxError('too_old')
  if (res.status === 422) throw new FlaxError('no_paper')
  // 旧版 Flax 没有新接口：/targets 这些回 404，/file 因为不是 JSON 回 415
  if ((res.status === 404 && path !== '/open') || (res.status === 415 && path.startsWith('/file'))) throw new FlaxError('old_flax', '请把 Flax 更新到最新版本')
  if (!res.ok) {
    const msg = await res.json().then((j: { message?: string; error?: string }) => j.message ?? j.error ?? '').catch(() => '')
    throw new FlaxError('failed', msg || `Flax 返回 ${res.status}`)
  }
  return (await res.json()) as T
}

const json = <T>(path: string, body: unknown, timeoutMs = 5000) => call<T>(path, JSON.stringify(body), 'application/json', timeoutMs)

export const flax = {
  ping: () => json<{ app: string; version: string; apiVersion: number }>('/ping', {}, 1500),
  lookup: (page: PageInfo) => json<{ paper: PaperRef | null }>('/lookup', page).then((r) => r.paper),
  /** quiet：网页里显示了保存窗口，Flax 不用再发系统通知 */
  // 联网查元数据可能要十几秒（arXiv 有限速）；直接打开的 PDF 要等 Flax 下完文件，大文件更久
  save: (page: PageInfo, quiet: boolean) => json<Saved>('/save', { ...page, quiet }, page.isPdf ? 115_000 : 60_000),
  /** 插件下好的 PDF 传给 Flax。带 paperId 是配给刚存的那篇，不带是直接打开的 PDF 标签页（当作新的一篇导入） */
  file: (data: ArrayBuffer, name: string, paperId: string | null, quiet: boolean) => {
    const q = new URLSearchParams({ name, ...(paperId ? { paperId } : {}), ...(quiet ? { quiet: '1' } : {}) })
    return call<Saved>(`/file?${q}`, data, 'application/pdf', 115_000)
  },
  /** 网页上没下到 PDF：让 Flax 找免费的版本（arXiv、开放获取），等它下完 */
  findPdf: (paperId: string) => json<PaperRef>('/findPdf', { paperId }, 115_000),
  targets: () => json<{ folders: Folder[]; tags: string[] }>('/targets', {}),
  update: (paperId: string, patch: SavedPatch) => json<PaperRef>('/update', { paperId, patch }),
  open: (paperId: string) => json<{ ok: boolean }>('/open', { paperId })
}
