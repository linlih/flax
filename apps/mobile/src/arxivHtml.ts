// arXiv 网页版存在手机的缓存目录：<缓存>/arxiv-html/<编号vN>/。不同步，系统清掉了下次再下载。
// 阅读器网页从 file:// 读 index.html 和图片（iOS 允许读整个应用目录，Android 允许读文件）。
import { Directory, File, Paths } from 'expo-file-system'
import { ensureArxivHtml, type HtmlFiles, type HtmlGet, type HtmlResult } from '@flax/core'

const root = () => new Directory(Paths.cache, 'arxiv-html')

function at(key: string, name: string): File {
  if (!/^[\w.-]+$/.test(key) || !/^(img\/)?[\w.-]+$/.test(name) || name.includes('..') || key.includes('..')) throw new Error('bad path')
  return new File(root(), key, name)
}

function ensureDir(f: File) {
  const dir = f.parentDirectory
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true })
}

const files: HtmlFiles = {
  readText: async (key, name) => {
    const f = at(key, name)
    return f.exists ? f.text() : null
  },
  writeText: async (key, name, text) => {
    const f = at(key, name)
    ensureDir(f)
    if (!f.exists) f.create()
    f.write(text)
  },
  writeBytes: async (key, name, data) => {
    const f = at(key, name)
    ensureDir(f)
    if (!f.exists) f.create()
    f.write(data)
  }
}

const get: HtmlGet = async (url) => {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 60_000)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Flax/0.1 (open-source reference manager)' }, signal: ctl.signal })
    return { status: res.status, body: new Uint8Array(await res.arrayBuffer()), type: res.headers.get('content-type') ?? '' }
  } finally {
    clearTimeout(timer)
  }
}

const running = new Map<string, Promise<HtmlResult>>()

/** 确保本机有这一版的网页版；成功时给出它所在文件夹的 file:// 地址 */
export async function arxivHtml(id: string, version: string | null): Promise<HtmlResult & { base?: string }> {
  const k = `${id}${version ?? ''}`
  let p = running.get(k)
  if (!p) {
    p = ensureArxivHtml(id, version, { files, get }).finally(() => running.delete(k))
    running.set(k, p)
  }
  const r = await p
  return r.ok ? { ...r, base: new Directory(root(), r.key).uri.replace(/\/?$/, '/') } : r
}
