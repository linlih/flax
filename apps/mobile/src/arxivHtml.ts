// arXiv 网页版：整页（图内嵌）存成一个文件，放在资料文件夹里按哈希存（和 PDF 一样），记在论文上、跟着同步。
// 不放缓存目录：系统清理缓存不会丢。阅读器网页从 file:// 读这个文件。
// <缓存>/arxiv-html/ 是以前存的：里面已经有的直接打包进资料文件夹，不用再下载；"没有网页版"的记录也记在这。
import { Directory, File, Paths } from 'expo-file-system'
import { ensureWebCopy, type HtmlFiles, type HtmlGet, type WebCopyResult } from '@flax/core'
import { hasPdf, pdfFile, putPdf } from './platform/files'
import { app } from './services'

const root = () => new Directory(Paths.cache, 'arxiv-html')

function at(key: string, name: string): File {
  if (!/^[\w.-]+$/.test(key) || !/^(img\/)?[\w.-]+$/.test(name) || name.includes('..') || key.includes('..')) throw new Error('bad path')
  return new File(root(), key, name)
}

const cache: HtmlFiles = {
  readText: async (key, name) => {
    const f = at(key, name)
    return f.exists ? f.text() : null
  },
  readBytes: async (key, name) => {
    const f = at(key, name)
    return f.exists ? f.bytes() : null
  },
  writeText: async (key, name, text) => {
    const f = at(key, name)
    const dir = f.parentDirectory
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true })
    if (!f.exists) f.create()
    f.write(text)
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

const running = new Map<string, Promise<WebCopyResult>>()

/** 确保这篇论文有网页版、本机读得到；成功时给出那个文件的 file:// 地址 */
export async function webCopy(paperId: string, id: string, version: string | null): Promise<WebCopyResult & { uri?: string }> {
  const k = `${paperId}/${version ?? ''}`
  let p = running.get(k)
  if (!p) {
    const s = app()
    p = ensureWebCopy(paperId, id, version, {
      library: {
        getPaper: (pid) => s.library.getPaper(pid),
        addWebCopy: (pid, copy) => {
          const paper = s.library.addWebCopy(pid, copy)
          // 新存的一份：几秒后传到同步
          s.changed()
          return paper
        }
      },
      store: { has: hasPdf, put: (data) => putPdf(data) },
      fetchSynced: (hash) => s.sync.download(hash),
      get,
      cache
    }).finally(() => running.delete(k))
    running.set(k, p)
  }
  const r = await p
  return r.ok ? { ...r, uri: pdfFile(r.hash).uri } : r
}
