// 后台：页面加载完以后看看库里有没有这一篇，有就在图标上打个勾。Flax 没开时什么都不做。
import { looksLikePaper } from '../utils/extract'
import { flax } from '../utils/flax'
import { markSaved, readTab } from '../utils/tab'

export default defineBackground(() => {
  const check = async (tabId: number, url: string | undefined) => {
    if (!url || !/^https?:/.test(url)) return
    const page = await readTab(tabId, url)
    if (!looksLikePaper(page)) return markSaved(tabId, false)
    const known = await flax.lookup(page).catch(() => null)
    await markSaved(tabId, !!known)
  }
  browser.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.status === 'complete') void check(tabId, tab.url)
  })
})
