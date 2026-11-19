// 读当前标签页上的论文信息；打不进页面（PDF 阅读器、浏览器自己的页面、商店）时只看网址。
import { extractPage, pageFromUrl, type PageInfo } from './extract'

export async function readTab(tabId: number, url: string): Promise<PageInfo> {
  if (!/^https?:/.test(url)) return pageFromUrl(url)
  try {
    const [r] = await browser.scripting.executeScript({ target: { tabId }, func: extractPage })
    const info = r?.result as PageInfo | undefined
    if (info) return info
  } catch {
    // 注入不了（比如 Chrome 自带的 PDF 阅读器）
  }
  return pageFromUrl(url)
}

/** 图标上的小勾：库里已经有这一篇 */
export async function markSaved(tabId: number, saved: boolean): Promise<void> {
  try {
    await browser.action.setBadgeBackgroundColor({ tabId, color: '#155DFC' })
    await browser.action.setBadgeText({ tabId, text: saved ? '✓' : '' })
    await browser.action.setTitle({ tabId, title: saved ? '已在 Flax 文献库' : '存进 Flax' })
  } catch {
    // 标签页已经关了
  }
}
