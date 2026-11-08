// 联网请求：超时、标识自己、按服务方的要求限速。
// 元数据查询和下载 PDF 共用一个限速表，arXiv 的两个域名都算在它的 3 秒里。
import type { FetchBytes, FetchText } from '@flax/core'

const USER_AGENT = 'Flax/0.1 (open-source desktop reference manager)'
/** arXiv 要求每 3 秒最多一次请求；Crossref 对礼貌请求没有硬限制，留一点间隔 */
const SPACING_MS: Record<string, number> = { 'export.arxiv.org': 3000, 'arxiv.org': 3000, 'api.crossref.org': 250 }
/** 再大的 PDF 也不该超过这个，防止对方返回异常内容把内存撑满 */
const MAX_PDF_BYTES = 200 * 1024 * 1024

export type { FetchBytes }

export function createNet(fetchImpl: typeof fetch = fetch, opts: { textTimeoutMs?: number; fileTimeoutMs?: number } = {}): { fetchText: FetchText; fetchBytes: FetchBytes } {
  const nextSlot = new Map<string, number>()
  const wait = async (url: string) => {
    const host = new URL(url).host
    const gap = SPACING_MS[host] ?? 0
    if (!gap) return
    const now = Date.now()
    const at = Math.max(now, nextSlot.get(host) ?? 0)
    nextSlot.set(host, at + gap)
    if (at > now) await new Promise((r) => setTimeout(r, at - now))
  }
  const get = async (url: string, timeoutMs: number) => {
    await wait(url)
    return fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: '*/*' }, signal: AbortSignal.timeout(timeoutMs) })
  }

  return {
    fetchText: async (url) => {
      const res = await get(url, opts.textTimeoutMs ?? 15000)
      return { status: res.status, body: await res.text() }
    },
    fetchBytes: async (url) => {
      const res = await get(url, opts.fileTimeoutMs ?? 120000)
      const len = Number(res.headers.get('content-length') ?? 0)
      if (len > MAX_PDF_BYTES) throw new Error('文件太大')
      const body = new Uint8Array(await res.arrayBuffer())
      if (body.byteLength > MAX_PDF_BYTES) throw new Error('文件太大')
      return { status: res.status, body }
    }
  }
}
