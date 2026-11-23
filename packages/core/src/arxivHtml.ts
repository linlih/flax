// arXiv 网页版（arxiv.org/html/<编号>）：下载一份存在本机，图片也存下来，离线也能读。
// 桌面（主进程）和手机（React Native）共用；存文件和联网由平台传进来。
// 网页里的脚本、样式这里不管：显示前在阅读器里用 DOMParser 清理（见 reader/html/article.ts）。

/** 存网页的地方：每一份（编号 + 版本）一个文件夹 */
export interface HtmlFiles {
  readText(key: string, name: string): Promise<string | null>
  writeText(key: string, name: string, text: string): Promise<void>
  writeBytes(key: string, name: string, data: Uint8Array): Promise<void>
}

/** 平台的下载：不限速（一个网页加几张图，和浏览器打开一样） */
export type HtmlGet = (url: string) => Promise<{ status: number; body: Uint8Array; type?: string }>

export type HtmlResult =
  | { ok: true; key: string; version: string | null }
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

/** 存下来的网页的格式：比它旧的、里面还有没存的图，打开时重新下载一次 */
const FORMAT = 2

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

const EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/svg+xml': '.svg', 'image/webp': '.webp' }

/**
 * 确保本机有这篇的网页版。version 是 PDF 上的版本（vN），要和 PDF 对得上批注才能对上；
 * 不知道版本就取最新的。已经存过的直接用。
 */
export async function ensureArxivHtml(id: string, version: string | null, d: { files: HtmlFiles; get: HtmlGet; now?: () => number }): Promise<HtmlResult> {
  const now = d.now ?? Date.now
  const key = htmlKey(id, version)
  /** 要重新下载的旧副本：下载不成就接着用它 */
  let stale: HtmlResult | null = null
  const meta = await d.files.readText(key, 'meta.json').catch(() => null)
  if (meta) {
    try {
      const m = JSON.parse(meta) as { ok?: boolean; version?: string | null; checkedAt?: number; format?: number }
      if (m.ok) {
        const done = { ok: true as const, key, version: m.version ?? version }
        if ((m.format ?? 1) >= FORMAT) return done
        // 旧格式没存 <object> 里的图：有这种图才重新下载，下同一版
        const old = await d.files.readText(key, 'index.html').catch(() => null)
        if (old && !/<object\b[^>]*\stype="image\//i.test(old)) return done
        version = version ?? m.version ?? null
        stale = done
      }
      if (m.ok === false && now() - (m.checkedAt ?? 0) < NONE_TTL_MS) return { ok: false, reason: 'none' }
    } catch {
      /* 坏了就重新下载 */
    }
  }

  const page = `${BASE}${id}${version ?? ''}`
  let res: Awaited<ReturnType<HtmlGet>>
  try {
    res = await d.get(page)
  } catch (e) {
    return stale ?? { ok: false, reason: 'offline', message: e instanceof Error ? e.message : String(e) }
  }
  if (res.status === 404 || res.status === 410) {
    if (stale) return stale
    await d.files.writeText(key, 'meta.json', JSON.stringify({ ok: false, checkedAt: now() }))
    return { ok: false, reason: 'none' }
  }
  if (res.status !== 200) return stale ?? { ok: false, reason: 'offline', message: `arXiv 返回 ${res.status}` }
  if (res.body.byteLength > MAX_HTML_BYTES) return stale ?? { ok: false, reason: 'none' }
  let html = new TextDecoder().decode(res.body)
  if (!hasArticle(html)) {
    if (stale) return stale
    await d.files.writeText(key, 'meta.json', JSON.stringify({ ok: false, checkedAt: now() }))
    return { ok: false, reason: 'none' }
  }
  const found = versionInHtml(html, id) ?? version
  html = objectsToImages(html)

  // 正文里的图存到本机，网页里的地址改成本地的相对路径
  const start = html.search(/<article[\s>]/)
  const end = html.lastIndexOf('</article>')
  const body = start >= 0 && end > start ? html.slice(start, end) : html
  const srcs = [...new Set([...body.matchAll(/<img\b[^>]*?\ssrc="([^"]+)"/g)].map((m) => m[1]!))].filter((s) => !/^data:/i.test(s)).slice(0, MAX_IMAGES)
  const local = new Map<string, string>()
  let n = 0
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
      const ext = EXT[(r.type ?? '').split(';')[0]!.trim()] ?? (/\.(png|jpe?g|gif|svg|webp)$/i.exec(url.pathname)?.[0]?.toLowerCase() ?? '.png')
      const name = `img/${++n}${ext}`
      await d.files.writeBytes(key, name, r.body)
      local.set(src, name)
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  html = html.replace(/(<img\b[^>]*?\ssrc=")([^"]+)(")/g, (m, a: string, src: string, b: string) => (local.has(src) ? a + local.get(src)! + b : m))

  await d.files.writeText(key, 'index.html', html)
  await d.files.writeText(key, 'meta.json', JSON.stringify({ ok: true, id, version: found, fetchedAt: now(), images: local.size, format: FORMAT }))
  return { ok: true, key, version: found }
}
