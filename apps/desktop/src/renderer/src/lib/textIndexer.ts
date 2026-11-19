// 全文搜索的索引：在后台用 pdf.js 一篇一篇读出 PDF 每页的文字，交给主进程存起来。
// 读的时候不占着界面：每读几页歇一下；打开阅读器时先停下，让阅读器的 pdf.js 先用。
import { api } from './library'
import { loadDocument } from '../reader/pdf'

let running = false
let again = false
let paused = false
const listeners = new Set<() => void>()

const rest = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 有新的 PDF 读进索引了（搜索结果要刷新） */
export function onIndexed(cb: () => void): () => void {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}

/** 阅读器开着时暂停 */
export function pauseIndexing(v: boolean): void {
  paused = v
}

/** 看看有没有还没读的 PDF，有就开始读（已经在读就读完这轮再看一次） */
export function kickIndexer(): void {
  if (running) {
    again = true
    return
  }
  running = true
  void (async () => {
    try {
      do {
        again = false
        const todo = await api.search.pending()
        for (const hash of todo) {
          await readOne(hash)
          listeners.forEach((cb) => cb())
          await rest(100)
        }
      } while (again)
    } catch (e) {
      console.error('text index:', e)
    } finally {
      running = false
    }
  })()
}

async function readOne(hash: string): Promise<void> {
  while (paused) await rest(1000)
  const { promise, destroy } = loadDocument(hash)
  try {
    const doc = await promise
    const pages: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      while (paused) await rest(1000)
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      pages.push(tc.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join(''))
      page.cleanup()
      if (i % 8 === 0) await rest(30)
    }
    await api.search.put(hash, pages)
  } catch (e) {
    // 读不了的 PDF（损坏、加密）记成没有文字，不反复重试
    console.warn('text index: cannot read', hash, e)
    await api.search.put(hash, []).catch(() => {})
  } finally {
    destroy()
  }
}
