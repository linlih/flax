// PDF 自带的目录（书签）：摊平成一个列表，每条带层级和页码，方便显示、折叠和标出"现在读到哪一节"。
// 只依赖 pdf.js 文档对象的形状，不 import pdf.js，方便测试。

export interface OutlineItem {
  id: number
  title: string
  /** 第几层，最外层是 0 */
  level: number
  /** 上一层那条的 id；最外层是 -1 */
  parent: number
  hasKids: boolean
  /** 跳到哪一页（从 1 开始）；指向网页或者坏掉的条目没有 */
  page?: number
  /** 原样交给 pdf.js 跳转，能落到页内的具体位置 */
  dest: unknown
}

interface RawItem {
  title: string
  dest: string | unknown[] | null
  items?: RawItem[]
}

export interface OutlineDoc {
  getOutline(): Promise<RawItem[] | null | undefined>
  getDestination(id: string): Promise<unknown[] | null>
  getPageIndex(ref: never): Promise<number>
}

export async function loadOutline(doc: OutlineDoc): Promise<OutlineItem[]> {
  const raw = await doc.getOutline().catch(() => null)
  if (!raw?.length) return []
  const out: OutlineItem[] = []
  const walk = (items: RawItem[], level: number, parent: number) => {
    for (const it of items) {
      const title = it.title.replace(/\s+/g, ' ').trim()
      const kids = it.items ?? []
      // 没有标题也没有下一层的条目是坏的，跳过
      if (!title && !kids.length) continue
      const id = out.length
      out.push({ id, title: title || '（无标题）', level, parent, hasKids: kids.length > 0, dest: it.dest })
      walk(kids, level + 1, id)
    }
  }
  walk(raw, 0, -1)
  await Promise.all(
    out.map(async (it) => {
      try {
        const dest = typeof it.dest === 'string' ? await doc.getDestination(it.dest) : it.dest
        const target = Array.isArray(dest) ? dest[0] : null
        if (typeof target === 'number') it.page = target + 1
        else if (target && typeof target === 'object') it.page = (await doc.getPageIndex(target as never)) + 1
      } catch {
        /* 这一条跳不了，照样显示 */
      }
    })
  )
  return out
}

/** 现在这一页属于哪一条：页码不超过当前页的最后一条 */
export function currentItem(items: OutlineItem[], page: number): number {
  let best = -1
  let bestPage = 0
  for (const it of items) {
    if (it.page !== undefined && it.page <= page && it.page >= bestPage) {
      best = it.id
      bestPage = it.page
    }
  }
  return best
}

/** 一条的所有上层 */
export function ancestors(items: OutlineItem[], id: number): number[] {
  const out: number[] = []
  for (let p = items[id]?.parent ?? -1; p >= 0; p = items[p]!.parent) out.push(p)
  return out
}

/** 折叠以后还看得见的条目：上面每一层都展开着 */
export function visibleItems(items: OutlineItem[], open: ReadonlySet<number>): OutlineItem[] {
  const shown = new Set<number>([-1])
  const out: OutlineItem[] = []
  for (const it of items) {
    if (!shown.has(it.parent)) continue
    out.push(it)
    if (open.has(it.id)) shown.add(it.id)
  }
  return out
}
