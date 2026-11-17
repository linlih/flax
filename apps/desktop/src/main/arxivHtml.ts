// arXiv 网页版存在本机：<用户数据>/arxiv-html/<编号vN>/。不放资料文件夹（不用同步，丢了重新下载就是）。
// 渲染进程从 flax://arxiv/<key>/index.html 读（见 protocol.ts）。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'
import { ensureArxivHtml, type HtmlFiles, type HtmlGet, type HtmlResult } from '@flax/core'

export function createArxivHtml(root: string, fetchImpl: (url: string, init: RequestInit) => Promise<Response>): (id: string, version: string | null) => Promise<HtmlResult> {
  const at = (key: string, name: string) => {
    const p = normalize(join(root, key, name))
    if (!p.startsWith(normalize(root) + sep)) throw new Error('bad path')
    return p
  }
  const files: HtmlFiles = {
    readText: async (key, name) => readFile(at(key, name), 'utf8').catch(() => null),
    writeText: async (key, name, text) => {
      const p = at(key, name)
      await mkdir(dirname(p), { recursive: true })
      await writeFile(p, text)
    },
    writeBytes: async (key, name, data) => {
      const p = at(key, name)
      await mkdir(dirname(p), { recursive: true })
      await writeFile(p, data)
    }
  }
  const get: HtmlGet = async (url) => {
    const res = await fetchImpl(url, { headers: { 'User-Agent': 'Flax/0.1 (open-source desktop reference manager)' }, signal: AbortSignal.timeout(60_000) })
    return { status: res.status, body: new Uint8Array(await res.arrayBuffer()), type: res.headers.get('content-type') ?? '' }
  }
  // 同一篇同时只下载一次（切换来回、两个窗口）
  const running = new Map<string, Promise<HtmlResult>>()
  return (id, version) => {
    const k = `${id}${version ?? ''}`
    let p = running.get(k)
    if (!p) {
      p = ensureArxivHtml(id, version, { files, get }).finally(() => running.delete(k))
      running.set(k, p)
    }
    return p
  }
}
