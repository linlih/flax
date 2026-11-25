// arXiv 网页版（arxiv.org/html/<编号>）：下载一次，图片内嵌进网页（data: 地址），整页存成一个 HTML 文件。
// 这个文件和 PDF 一样按哈希存在资料文件夹里、记在论文上（Paper.webCopies），跟着同步传到别的设备；
// 手机上不放缓存目录，系统清理也不会丢。
// 桌面（主进程）和手机（React Native）共用；存文件和联网由平台传进来。
// 网页里的脚本、样式这里不管：显示前在阅读器里用 DOMParser 清理（见 reader/html/article.ts）。
import type { Paper, UUID, WebCopy } from './model'
import { toBase64, utf8 } from './sync/codec'

/** 旧版本存网页的地方（每一份一个文件夹，图片单独存）：还在的就直接打包，不用再下载；"没有网页版"的记录也记在这 */
export interface HtmlFiles {
  readText(key: string, name: string): Promise<string | null>
  readBytes(key: string, name: string): Promise<Uint8Array | null>
  writeText(key: string, name: string, text: string): Promise<void>
}

/** 平台的下载：不限速（一个网页加几张图，和浏览器打开一样） */
export type HtmlGet = (url: string) => Promise<{ status: number; body: Uint8Array; type?: string }>

export interface WebCopyDeps {
  library: { getPaper(id: UUID): Paper | null; addWebCopy(id: UUID, copy: WebCopy): Paper }
  /** 资料文件夹里按哈希存的文件（和 PDF 同一处） */
  store: { has(hash: string): boolean | Promise<boolean>; put(data: Uint8Array): Promise<string> }
  /** 本机没有、同步的云端可能有：下载下来，有了返回 true */
  fetchSynced?: (hash: string) => Promise<boolean>
  get: HtmlGet
  cache: HtmlFiles
  now?: () => number
}

export type WebCopyResult =
  | { ok: true; hash: string; version: string | null }
  /** none：arXiv 没有这篇的网页版（或转换失败）；offline：没连上，下次再试 */
  | { ok: false; reason: 'none' | 'offline'; message?: string }

const BASE = 'https://arxiv.org/html/'
/** 没有网页版的结果记一阵，免得每次打开都去问 */
const NONE_TTL_MS = 7 * 24 * 3600_000
const MAX_IMAGES = 200
const MAX_HTML_BYTES = 30 * 1024 * 1024

/** 文件夹名：旧式编号里的斜杠换掉 */
export function htmlKey(id: string, version: string | null): string {
  return `${id.replace(/[^\w.-]/g, '_')}${version ?? ''}`
}

/** PDF 文字里 arXiv 盖的戳带着版本号：arXiv:1706.03762v7 [cs.CL] … */
export function arxivVersionIn(text: string, id: string): string | null {
  const esc = id.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  return new RegExp(`arXiv:\\s*${esc}(v\\d+)`, 'i').exec(text)?.[1] ?? null
}

/** 转换成功的网页才有正文；转换失败的只有一个空架子 */
export function hasArticle(html: string): boolean {
  return /<article[^>]*ltx_document/.test(html) && (html.match(/class="ltx_para/g)?.length ?? 0) >= 3
}

/** 网页里写着自己是哪一版：页头"返回摘要页"的链接 /abs/<编号>vN */
export function versionInHtml(html: string, id: string): string | null {
  const esc = id.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  return new RegExp(`/abs/${esc}(v\\d+)`).exec(html)?.[1] ?? null
}

/** arXiv 的 SVG 图放在 <object type="image/svg+xml" data="…">（多是 TikZ 画的图），阅读器不放 object：
 *  改成 <img>，和别的图一样存到本机。img 里的 SVG 不跑脚本 */
export function objectsToImages(html: string): string {
  return html.replace(/<object\b([^>]*)>([\s\S]*?)<\/object>/gi, (m, attrs: string) => {
    if (!/\stype="image\/[^"]+"/i.test(attrs)) return m
    const data = /\sdata="([^"]+)"/i.exec(attrs)?.[1]
    if (!data) return m
    const rest = attrs.replace(/\s(type|data)="[^"]*"/gi, '')
    return `<img src="${data}"${rest}>`
  })
}

/**
 * 确保这篇论文有网页版、本机读得到。version 是 PDF 上的版本（vN），要和 PDF 对得上批注才能对上；
 * 不知道版本就取最新的。存过的直接用；本机没有就先从同步下载，再不行才去 arXiv 下载。
 */
export async function ensureWebCopy(paperId: UUID, id: string, version: string | null, d: WebCopyDeps): Promise<WebCopyResult> {
  const now = d.now ?? Date.now
  const paper = d.library.getPaper(paperId)
  const copies = paper?.webCopies ?? []
  const have = copies.find((c) => c.want === version) ?? (version ? copies.find((c) => c.version === version) : undefined)
  if (have) {
    if (await d.store.has(have.hash)) return { ok: true, hash: have.hash, version: have.version }
    if (d.fetchSynced && (await d.fetchSynced(have.hash).catch(() => false))) return { ok: true, hash: have.hash, version: have.version }
  }

  const key = htmlKey(id, version)
  let got = await fromOldCopy(key, d.cache)
  if (!got) {
    const r = await download(id, version, d, now)
    if ('reason' in r) return r
    got = r
  }
  const data = utf8(got.html)
  const hash = await d.store.put(data)
  if (paper) d.library.addWebCopy(paperId, { hash, size: data.byteLength, want: version, version: got.version, addedAt: new Date(now()).toISOString() })
  return { ok: true, hash, version: got.version }
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' }

const dataUri = (type: string, body: Uint8Array) => `data:${type};base64,${toBase64(body)}`

/** 以前存在缓存文件夹里的一份：图片内嵌进去，不用再下载。缺图的旧格式（<object> 里的图没存）不要 */
async function fromOldCopy(key: string, cache: HtmlFiles): Promise<{ html: string; version: string | null } | null> {
  const meta = await cache.readText(key, 'meta.json').catch(() => null)
  if (!meta) return null
  let m: { ok?: boolean; version?: string | null; format?: number }
  try {
    m = JSON.parse(meta)
  } catch {
    return null
  }
  if (!m.ok) return null
  let html = await cache.readText(key, 'index.html').catch(() => null)
  if (!html || ((m.format ?? 1) < 2 && /<object\b[^>]*\stype="image\//i.test(html))) return null
  const names = [...new Set([...html.matchAll(/<img\b[^>]*?\ssrc="(img\/\d+\.(\w+))"/g)].map((x) => x[1]!))]
  const inlined = new Map<string, string>()
  for (const name of names) {
    const body = await cache.readBytes(key, name).catch(() => null)
    const type = MIME[name.split('.').pop()!.toLowerCase()]
    if (body && type) inlined.set(name, dataUri(type, body))
  }
  html = html.replace(/(<img\b[^>]*?\ssrc=")(img\/\d+\.\w+)(")/g, (all, a: string, src: string, b: string) => (inlined.has(src) ? a + inlined.get(src)! + b : all))
  return { html, version: m.version ?? null }
}

async function download(id: string, version: string | null, d: WebCopyDeps, now: () => number): Promise<{ html: string; version: string | null } | { ok: false; reason: 'none' | 'offline'; message?: string }> {
  const key = htmlKey(id, version)
  const meta = await d.cache.readText(key, 'meta.json').catch(() => null)
  if (meta) {
    try {
      const m = JSON.parse(meta) as { ok?: boolean; checkedAt?: number }
      if (m.ok === false && now() - (m.checkedAt ?? 0) < NONE_TTL_MS) return { ok: false, reason: 'none' }
    } catch {
      /* 坏了就重新下载 */
    }
  }
  const none = async () => {
    await d.cache.writeText(key, 'meta.json', JSON.stringify({ ok: false, checkedAt: now() })).catch(() => undefined)
    return { ok: false as const, reason: 'none' as const }
  }

  const page = `${BASE}${id}${version ?? ''}`
  let res: Awaited<ReturnType<HtmlGet>>
  try {
    res = await d.get(page)
  } catch (e) {
    return { ok: false, reason: 'offline', message: e instanceof Error ? e.message : String(e) }
  }
  if (res.status === 404 || res.status === 410) return none()
  if (res.status !== 200) return { ok: false, reason: 'offline', message: `arXiv 返回 ${res.status}` }
  if (res.body.byteLength > MAX_HTML_BYTES) return { ok: false, reason: 'none' }
  let html = new TextDecoder().decode(res.body)
  if (!hasArticle(html)) return none()
  const found = versionInHtml(html, id) ?? version
  html = objectsToImages(html)

  // 正文里的图下载下来，内嵌进网页
  const start = html.search(/<article[\s>]/)
  const end = html.lastIndexOf('</article>')
  const body = start >= 0 && end > start ? html.slice(start, end) : html
  const srcs = [...new Set([...body.matchAll(/<img\b[^>]*?\ssrc="([^"]+)"/g)].map((m) => m[1]!))].filter((s) => !/^data:/i.test(s)).slice(0, MAX_IMAGES)
  const inlined = new Map<string, string>()
  const queue = [...srcs]
  const worker = async () => {
    for (let src = queue.shift(); src !== undefined; src = queue.shift()) {
      let url: URL
      try {
        url = new URL(src.replace(/&amp;/g, '&'), page)
      } catch {
        continue
      }
      if (url.protocol !== 'https:' || !/(^|\.)arxiv\.org$/.test(url.hostname) || url.hostname.startsWith('static.')) continue
      const r = await d.get(url.href).catch(() => null)
      if (!r || r.status !== 200 || !r.body.byteLength) continue
      const type = (r.type ?? '').split(';')[0]!.trim().toLowerCase()
      const mime = type.startsWith('image/') ? type : MIME[/\.(\w+)$/.exec(url.pathname)?.[1]?.toLowerCase() ?? ''] ?? 'image/png'
      inlined.set(src, dataUri(mime, r.body))
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  html = html.replace(/(<img\b[^>]*?\ssrc=")([^"]+)(")/g, (m, a: string, src: string, b: string) => (inlined.has(src) ? a + inlined.get(src)! + b : m))
  return { html, version: found }
}
