// 后台：点了工具栏图标就开始存（docs/12-浏览器插件.md 第 10 节）。不弹浏览器小窗，在网页右上角放一个保存窗口；
// 保存在这里做，窗口关了、点了别处也会存完。
//   1. 读页面上的论文信息，交给 Flax 存（直接打开的 PDF：插件下载文件传过去）
//   2. 网页上有 PDF 链接就在这里下载（带着浏览器的登录状态，学校买了的出版社 PDF 也能下），传给 Flax
//   3. 网页上没下到，请 Flax 找免费的版本（arXiv、开放获取）
// 页面加载完时也看一眼库里有没有这一篇，有就在图标上打个勾。
import { looksLikePaper, type PageInfo } from '../utils/extract'
import { flax, FlaxError, type Saved } from '../utils/flax'
import { downloadPdf } from '../utils/pdf'
import { busy, type PdfStep, type SaveState, type ToBackground, type ToWindow } from '../utils/session'
import { markSaved, readTab } from '../utils/tab'

interface Session {
  state: SaveState
  page: PageInfo | null
  /** 网页里放得下保存窗口；放不下（浏览器自己的页面、商店）就只用图标和 Flax 的系统通知 */
  window: boolean
}

export default defineBackground(() => {
  const sessions = new Map<number, Session>()

  const push = (tabId: number, msg: ToWindow) => browser.tabs.sendMessage(tabId, msg).catch(() => {})

  const set = (tabId: number, state: SaveState) => {
    const s = sessions.get(tabId)
    if (!s) return
    s.state = state
    if (s.window) void push(tabId, { type: 'flax:state', state })
    else void badge(tabId, state)
  }

  /** 放不下窗口时，用图标上的字告诉用户进度 */
  const badge = async (tabId: number, st: SaveState) => {
    if (st.phase === 'saved' && !busy(st)) return markSaved(tabId, true)
    const [text, title] =
      busy(st) ? ['…', '正在存进 Flax…']
      : st.phase === 'no_paper' ? ['', '这个页面上没找到论文']
      : st.phase === 'offline' ? ['!', 'Flax 没有打开']
      : st.phase === 'error' ? ['!', `没存成：${st.message}`]
      : ['', '存进 Flax']
    try {
      await browser.action.setBadgeBackgroundColor({ tabId, color: text === '!' ? '#dc2626' : '#155DFC' })
      await browser.action.setBadgeText({ tabId, text })
      await browser.action.setTitle({ tabId, title })
    } catch {
      // 标签页已经关了
    }
  }

  /** 把保存窗口放进网页。放不进去返回 false */
  const showWindow = async (tabId: number): Promise<boolean> => {
    try {
      await browser.scripting.executeScript({ target: { tabId }, files: ['/content-scripts/save-window.js'] })
      await push(tabId, { type: 'flax:show' })
      return true
    } catch {
      return false
    }
  }

  async function lastFolder(): Promise<string | null> {
    try {
      const { lastFolder } = await browser.storage.local.get('lastFolder')
      return typeof lastFolder === 'string' ? lastFolder : null
    } catch {
      return null
    }
  }

  const pdfStep = (r: Saved | { pdf?: string; hasPdf: boolean }): PdfStep =>
    r.pdf === 'yes' || (!r.pdf && r.hasPdf) ? { kind: 'done' } : r.pdf === 'downloading' ? { kind: 'flax' } : { kind: 'none' }

  async function save(tabId: number, url: string) {
    const s = sessions.get(tabId)!
    set(tabId, { phase: 'reading' })
    const page = await readTab(tabId, url)
    s.page = page
    if (!looksLikePaper(page)) return set(tabId, { phase: 'no_paper' })
    set(tabId, { phase: 'saving', ...(page.meta.title ? { title: page.meta.title } : {}), pdfTab: page.isPdf })
    try {
      await flax.ping()
      let r: Saved
      if (page.isPdf) {
        // 直接打开的 PDF：先自己下（带登录状态），下不了再请 Flax 按网址下
        let file: Awaited<ReturnType<typeof downloadPdf>> | null = null
        try {
          file = await downloadPdf(page.url)
        } catch {
          file = null
        }
        r = file ? await flax.file(file.data, file.name, null, s.window) : await flax.save(page, s.window)
      } else {
        r = await flax.save(page, s.window)
      }
      // 新存的一篇放进上次选的文件夹（和 Zotero 一样记住上次的位置）；已经在库里的不动
      let folder: string | null = null
      const last = r.status === 'added' ? await lastFolder() : null
      if (last) {
        folder = await flax.update(r.paperId, { addFolder: last }).then(() => last, () => null)
      }
      let state: SaveState = { phase: 'saved', paperId: r.paperId, title: r.title, status: r.status, pdf: pdfStep(r), folder }
      set(tabId, state)
      void markSaved(tabId, true)
      if (state.pdf.kind === 'done') return

      // 网页上的 PDF 链接：插件自己下
      let reason: string | undefined
      if (state.pdf.kind === 'none' && page.pdfUrl) {
        set(tabId, (state = { ...state, pdf: { kind: 'page' } }))
        try {
          const file = await downloadPdf(page.pdfUrl)
          const got = await flax.file(file.data, file.name, r.paperId, true)
          if (got.pdf !== 'no') return set(tabId, { ...state, pdf: { kind: 'done' } })
        } catch (e) {
          if (e instanceof FlaxError && e.kind === 'offline') throw e
          reason = e instanceof Error ? e.message : String(e)
        }
      }
      // Flax 自己找（arXiv 的就是等它下完）
      set(tabId, (state = { ...state, pdf: { kind: 'flax' } }))
      const found = await flax.findPdf(r.paperId).catch((e: unknown) => {
        if (e instanceof FlaxError && e.kind === 'old_flax') return null
        throw e
      })
      set(tabId, { ...state, pdf: found && pdfStep(found).kind === 'done' ? { kind: 'done' } : { kind: 'missing', ...(reason ? { reason } : {}) } })
    } catch (e) {
      if (e instanceof FlaxError && e.kind === 'offline') return set(tabId, { phase: 'offline', waking: false })
      if (e instanceof FlaxError && e.kind === 'no_paper') return set(tabId, { phase: 'no_paper' })
      if (e instanceof FlaxError && e.kind === 'too_old') return set(tabId, { phase: 'error', message: '这个插件版本太旧了，请更新插件。' })
      set(tabId, { phase: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  /** Flax 没开：用 flax://open 唤起它，然后每秒问一次，连上就接着存 */
  async function wake(tabId: number) {
    const s = sessions.get(tabId)
    if (!s) return
    set(tabId, { phase: 'offline', waking: true })
    // 在当前标签页打开：浏览器问「要打开 Flax 吗」的框才看得见；外部协议不会让页面跳走
    try {
      await browser.tabs.update(tabId, { url: 'flax://open' })
    } catch {
      // 没装 Flax，或者浏览器不让打开
    }
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      if (await flax.ping().then(() => true, () => false)) {
        const tab = await browser.tabs.get(tabId).catch(() => null)
        return tab?.url ? save(tabId, tab.url) : undefined
      }
    }
    set(tabId, { phase: 'offline', waking: false })
  }

  browser.action.onClicked.addListener(async (tab) => {
    if (tab.id === undefined || !tab.url) return
    const tabId = tab.id
    const old = sessions.get(tabId)
    const shown = await showWindow(tabId)
    // 还在存：把窗口重新显示出来就行，不再存一遍
    if (old && busy(old.state)) {
      old.window = shown
      if (shown) void push(tabId, { type: 'flax:state', state: old.state })
      return
    }
    sessions.set(tabId, { state: { phase: 'reading' }, page: null, window: shown })
    await save(tabId, tab.url)
  })

  browser.runtime.onMessage.addListener((raw, sender) => {
    const tabId = sender.tab?.id
    const msg = raw as ToBackground
    if (tabId === undefined || typeof msg?.type !== 'string') return
    const s = sessions.get(tabId)
    const paperId = s?.state.phase === 'saved' ? s.state.paperId : null
    switch (msg.type) {
      case 'flax:hello':
        return Promise.resolve(s?.state ?? null)
      case 'flax:targets':
        return flax.targets().catch(() => null)
      case 'flax:folder': {
        if (!s || s.state.phase !== 'saved' || !paperId) return
        const prev = s.state.folder
        const next = msg.folder
        s.state = { ...s.state, folder: next }
        void browser.storage.local.set({ lastFolder: next })
        return flax.update(paperId, { ...(prev ? { removeFolder: prev } : {}), ...(next ? { addFolder: next } : {}) }).then(() => true, () => false)
      }
      case 'flax:tags':
        if (!paperId) return
        return flax.update(paperId, { ...(msg.add ? { addTags: msg.add } : {}), ...(msg.remove ? { removeTags: msg.remove } : {}) }).then(() => true, () => false)
      case 'flax:open':
        if (paperId) void flax.open(paperId).catch(() => {})
        return
      case 'flax:wake':
        void wake(tabId)
        return
      case 'flax:retry': {
        const url = sender.tab?.url
        if (!s || !url || busy(s.state)) return
        void save(tabId, url)
        return
      }
    }
  })

  // 换了页面，上一页的保存就和这个标签页没关系了
  const check = async (tabId: number, url: string | undefined) => {
    if (!url || !/^https?:/.test(url)) return
    const page = await readTab(tabId, url)
    if (!looksLikePaper(page)) return markSaved(tabId, false)
    const known = await flax.lookup(page).catch(() => null)
    await markSaved(tabId, !!known)
  }
  browser.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.url) sessions.delete(tabId)
    if (change.status === 'complete') void check(tabId, tab.url)
  })
  browser.tabs.onRemoved.addListener((tabId) => sessions.delete(tabId))
})
