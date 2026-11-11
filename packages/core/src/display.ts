// 界面上显示的文字和列表的筛选、排序。桌面和手机共用，不依赖平台。
import type { MatchIssue, MetadataSource, Paper, ReadingStatus, TagColor } from './model'
import { normalizeTitle } from './text'

export const STATUS_LABEL: Record<ReadingStatus, string> = { inbox: '未读', to_read: '待读', reading: '在读', done: '读过' }

export const MATCH_HINT: Record<MatchIssue, string> = {
  no_id: '没有找到 DOI 或 arXiv 编号',
  lookup_failed: '联网查询失败，可以重试',
  not_found: '编号没有查到对应的论文'
}

export const SOURCE_LABEL: Record<MetadataSource, string> = {
  arxiv: '来自 arXiv',
  crossref: '来自 Crossref',
  openalex: '来自 OpenAlex',
  pdf: '从 PDF 文字识别',
  filename: '用的是文件名',
  user: '手动编辑过'
}

export function authorLine(p: Pick<Paper, 'authors'>, max = 3): string {
  const names = p.authors.map((a) => [a.given, a.family].filter(Boolean).join(' '))
  if (names.length <= max) return names.join(', ')
  return `${names.slice(0, max).join(', ')} 等 ${names.length} 人`
}

export function addedLabel(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const mins = (now.getTime() - d.getTime()) / 60000
  if (mins < 2) return '刚刚'
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86400000)
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// —— 筛选 ——
const hayCache = new WeakMap<Paper, string>()

function hay(p: Paper): string {
  let h = hayCache.get(p)
  if (h === undefined) {
    h = normalizeTitle([p.title, authorLine(p, 99), p.venue ?? '', p.year ?? '', p.tags.join(' ')].join(' '))
    hayCache.set(p, h)
  }
  return h
}

export function filterPapers(papers: Paper[], query: string, tag = ''): Paper[] {
  const words = normalizeTitle(query).split(' ').filter(Boolean)
  return papers.filter((p) => (!tag || p.tags.includes(tag)) && (!words.length || words.every((w) => hay(p).includes(w))))
}

// —— 阅读状态 ——
export const STATUSES: ReadingStatus[] = ['inbox', 'to_read', 'reading', 'done']

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

// —— 标签 ——
/** 把一篇论文的标签 old 改成 next：位置不变；改成空就是删掉；改成已有的标签就合并成一个 */
export function renameTagIn(tags: string[], old: string, next: string): string[] {
  const t = next.trim().replace(/^#/, '')
  if (t === old) return tags
  if (!t || (tags.includes(t))) return tags.filter((x) => x !== old)
  return tags.map((x) => (x === old ? t : x))
}

export const TAG_COLOR_LABEL: Record<TagColor, string> = { red: '红色', orange: '橙色', yellow: '黄色', green: '绿色', blue: '蓝色', purple: '紫色', gray: '灰色' }

/** 标签 → 颜色 */
export function tagColorMap(tags: { tag: string; color?: TagColor }[]): Map<string, TagColor> {
  return new Map(tags.flatMap((t) => (t.color ? [[t.tag, t.color] as const] : [])))
}
