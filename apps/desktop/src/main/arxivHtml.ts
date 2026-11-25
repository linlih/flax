// arXiv 网页版：整页（图内嵌）存成一个文件，放在资料文件夹里按哈希存（和 PDF 一样），记在论文上、跟着同步。
// 渲染进程按哈希从 flax://file/<哈希> 读。
// <用户数据>/arxiv-html/ 是以前的缓存：里面已经有的直接打包进资料文件夹，不用再下载；"没有网页版"的记录也记在这。
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'
import { ensureWebCopy, type HtmlFiles, type HtmlGet, type WebCopyDeps, type WebCopyResult } from '@flax/core'
import type { FileStore } from './store'

export function createWebCopies(o: {
  cacheRoot: string
  store: FileStore
  library: WebCopyDeps['library']
  fetchSynced: (hash: string) => Promise<boolean>
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>
}): (paperId: string, id: string, version: string | null) => Promise<WebCopyResult> {
  const at = (key: string, name: string) => {
    const p = normalize(join(o.cacheRoot, key, name))
    if (!p.startsWith(normalize(o.cacheRoot) + sep)) throw new Error('bad path')
    return p
  }
  const cache: HtmlFiles = {
    readText: async (key, name) => readFile(at(key, name), 'utf8').catch(() => null),
    readBytes: async (key, name) => readFile(at(key, name)).then((b) => new Uint8Array(b), () => null),
    writeText: async (key, name, text) => {
      const p = at(key, name)
      await mkdir(dirname(p), { recursive: true })
      await writeFile(p, text)
    }
  }
  const get: HtmlGet = async (url) => {
    const res = await o.fetchImpl(url, { headers: { 'User-Agent': 'Flax/0.1 (open-source desktop reference manager)' }, signal: AbortSignal.timeout(60_000) })
    return { status: res.status, body: new Uint8Array(await res.arrayBuffer()), type: res.headers.get('content-type') ?? '' }
  }
  const store = {
    has: (hash: string) => stat(o.store.pathFor(hash)).then(() => true, () => false),
    put: (data: Uint8Array) => o.store.put(data)
  }
  // 同一篇同时只准备一次（切换来回、两个窗口）
  const running = new Map<string, Promise<WebCopyResult>>()
  return (paperId, id, version) => {
    const k = `${paperId}/${version ?? ''}`
    let p = running.get(k)
    if (!p) {
      p = ensureWebCopy(paperId, id, version, { library: o.library, store, fetchSynced: o.fetchSynced, get, cache }).finally(() => running.delete(k))
      running.set(k, p)
    }
    return p
  }
}
