// 阅读状态在界面上怎么显示：列表前面的标记、在读视图的进度和排序。
import type { Paper, ReadingStatus } from '@flax/core'
import type { IconName } from '../components/Icon'

export const STATUSES: ReadingStatus[] = ['inbox', 'to_read', 'reading', 'done']

export const STATUS_ICON: Record<Exclude<ReadingStatus, 'inbox'>, IconName> = { to_read: 'toread', reading: 'reading', done: 'done' }

/** 列表里标蓝点的"新论文"：未读，而且不是批量导入的 */
export function isNew(p: Paper): boolean {
  return p.readingStatus === 'inbox' && !p.batch
}

/** 读到第几页、一共几页；没读过或不知道总页数时是 null */
export function progress(p: Paper): { page: number; total: number } | null {
  // 这台设备和别的设备里最近读的那一次（在手机上读到第 12 页，列表里也是 12）
  let pos: { fileHash: string; page: number } | undefined = p.readingPosition
  let at = p.readingPosition?.updatedAt ?? ''
  for (const o of Object.values(p.positions ?? {})) if (o.at > at) (pos = o), (at = o.at)
  if (!pos) return null
  const file = p.files.find((f) => f.hash === pos.fileHash) ?? p.files[0]
  const total = file?.pageCount
  if (!total) return null
  return { page: Math.min(pos.page, total), total }
}

/** 在读的论文这么多天没打开，就沉到"最近没碰"里 */
export const STALE_DAYS = 30

export function isStale(p: Paper, now = Date.now()): boolean {
  const t = p.lastOpenedAt ? Date.parse(p.lastOpenedAt) : Date.parse(p.addedAt)
  return now - t > STALE_DAYS * 86400000
}

/** 在读视图：最近打开的在前，久没碰的放最后 */
export function sortReading(papers: Paper[], now = Date.now()): Paper[] {
  const opened = (p: Paper) => Date.parse(p.lastOpenedAt ?? p.addedAt)
  return [...papers].sort((a, b) => Number(isStale(a, now)) - Number(isStale(b, now)) || opened(b) - opened(a))
}

/** 读到最后两页时，阅读器提示"标为读过"（两页以内的短文一打开就在"最后"，不提示） */
export function nearEnd(page: number, total: number): boolean {
  return total > 2 && page >= total - 1
}
