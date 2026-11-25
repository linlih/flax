// 打开一篇论文去读：文库列表点一下、长按菜单的"开始读"、详情页的"开始读"都走这里。
// PDF 在手机上就直接进阅读；只在云端就先下载（列表那一行显示"正在下载 PDF…"）再进；读不了时：
// 从列表点的去详情页（那里有下载、配 PDF 的按钮），在详情页点的就提示原因。
import { router } from 'expo-router'
import type { Paper } from '@flax/core'
import { app, bump, showNotice } from './services'
import { hasPdf } from './platform/files'

/** 正在从云端下载 PDF、下好就打开的论文 */
const fetching = new Set<string>()
export const fetchingIds = (): ReadonlySet<string> => fetching

/** 最近一次要打开的：下载期间又点了别的，下好后就不再跳过去 */
let latest = 0

const mainFile = (p: Paper) => p.files.find((f) => f.role === 'main') ?? p.files[0]

/**
 * from 'list'：读不了就去详情页；from 'details'：已经在详情页了，提示原因（没有 PDF 时顺手从 arXiv 下载）
 */
export async function openPaper(paper: Paper, from: 'list' | 'details'): Promise<void> {
  const s = app()
  const main = mainFile(paper)
  const ticket = ++latest
  if (!main) {
    if (from === 'list') return void router.push(`/paper/${paper.id}`)
    if (s.importer.startDownload(paper.id)) showNotice('正在从 arXiv 下载 PDF')
    else showNotice('这篇论文没有 PDF。可以从"添加"里选一个 PDF，名字或 DOI 对得上会自动配给它。')
    s.changed()
    return
  }
  if (!hasPdf(main.hash)) {
    if (!s.sync.enabled) {
      if (from === 'list') return void router.push(`/paper/${paper.id}`)
      return showNotice('PDF 不在这台手机上。开启同步后可以从云端下载。')
    }
    if (fetching.has(paper.id)) return
    fetching.add(paper.id)
    bump('library')
    try {
      const ok = await s.sync.download(main.hash)
      if (!ok) return showNotice('云端也没有这个 PDF：可能那台电脑还没传上去。', from === 'list' ? paper.id : undefined)
    } catch (e) {
      return showNotice(`下载失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      fetching.delete(paper.id)
      bump('library')
    }
    if (ticket !== latest) return showNotice(`PDF 下载好了：${paper.title}`, paper.id)
  }
  router.push(`/read/${paper.id}`)
}
